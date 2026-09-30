#!/usr/bin/env bash
# =============================================================================
# Phase 4 exit-gate demonstration (§22).
#
#   infra/scripts/demo-phase4.sh [--on-host]
#
# Runs the assertions behind each Phase 4 gate rather than describing them, and
# says plainly which of the eight are not settled yet — this phase is in
# progress, so an honest report has open lines in it. Gate states follow A38:
# [x] green · [~] deferred with the command that will prove it · [ ] open, with
# the step of §22 that will close it.
#
# The pattern is demo-phase3.sh's, and so is the reasoning: the integration
# specs skip themselves without TEST_DATABASE_URL, so the database is started
# once for the whole run and its absence is a hard stop rather than a skip — a
# script that reports green while asserting nothing is worse than no script.
#
# Exit codes: 0 = no gate is red · 1 = a gate that should hold does not.
# Open gates do not make this script fail; they make it say what is left.
# =============================================================================
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 2
ON_HOST=0
for arg in "$@"; do
  [ "$arg" = '--on-host' ] && ON_HOST=1
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
LOG="${TMPDIR:-/tmp}/vorschicht-demo-phase4-$$.log"
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

printf '\033[1mPhase 4 — Eskalations-Inbox & Benachrichtigungen (§22)\033[0m\n'
[ "$ON_HOST" = 1 ] && printf 'Lauf auf dem Produktionshost.\n'

# One run, several gates: the escalation specs share a database, and starting
# it once per gate would multiply the slowest part of this script for nothing.
suite packages/core/src/escalation-service.itest.ts packages/core/src/agent-channel.itest.ts \
      packages/core/src/dev-chain.itest.ts packages/core/src/scheduler.test.ts \
      packages/shared/src/escalation.test.ts

# --- G3: the policy-memory gate (closed in the previous iteration) -----------
headline 'G3 — dieselbe Frage wird beim zweiten Mal aus der Präzedenz beantwortet (§15)'
g3=0
ran_green 'legt beim ersten Mal einen Eintrag ins Postfach' || g3=1
ran_green 'beantwortet dieselbe Frage beim zweiten Mal aus dem Gedächtnis, ohne neuen Eintrag' || g3=1
ran_green 'fragt in einem anderen Projekt erneut, statt die fremde Entscheidung anzuwenden' || g3=1
ran_green 'hängt eine ähnliche frühere Entscheidung als Kontext an, beantwortet aber nichts' || g3=1
ran_green 'zeigt einer fortgesetzten Sitzung die Antwort, nicht nur dass es eine gibt' || g3=1
if [ "$g3" = 0 ]; then
  green 'Policy-Memory: beantwortet · mit Verweis · ohne neue Karte — und §9s roter Pfad ist ausdrücklich ausgenommen (A77.2)'
else
  red 'das Policy-Memory ist nicht nachgewiesen — siehe '"$LOG"
fi

# --- the round trip: §22 step 3, and the buildable half of G1 ----------------
headline '§6.4 — die Runde: parken, entscheiden, dieselbe Sitzung fortsetzen'
rt=0
# The promise itself: the session that was resumed is the session that asked.
ran_green 'parkt beim Coder, setzt dieselbe Sitzung fort und läuft bis zur Freigabe durch' || rt=1
ran_green 'macht die Fortsetzung zu einem eigenen Lauf, der auf den geparkten zeigt' || rt=1
ran_green 'setzt den Planer fort und plant nicht neu' || rt=1
ran_green 'setzt den Reviewer fort, ohne den Coder noch einmal laufen zu lassen' || rt=1
ran_green 'zählt die Review-Runden über die Unterbrechung hinweg weiter' || rt=1
# What it refuses, and what it leaves alone.
ran_green 'setzt nichts fort, solange die Frage offen ist' || rt=1
ran_green 'verweigert die Fortsetzung, wenn die geparkte Rolle nicht zur Etappe passt' || rt=1
ran_green 'schreibt die Entscheidung in die Zeitleiste, bevor die Aufgabe sich bewegt' || rt=1
# The trigger: nothing above happens unless a tick decides it should.
ran_green 'setzt die geparkte Sitzung fort, sobald die Entscheidung beantwortet ist' || rt=1
ran_green 'lässt eine offene Frage in Ruhe — und meldet dazu gar nichts' || rt=1
ran_green 'setzt fort, bevor neue Arbeit beginnt' || rt=1
ran_green 'setzt gar nichts fort, solange der Wächter nicht "normal" sagt' || rt=1
# The hole the machinery closed on the way past: every resume path used to end
# at a state no dispatcher looked at.
ran_green 'nimmt eine geparkte Umsetzung bei "coding" wieder auf, ohne neu zu planen' || rt=1
if [ "$rt" = 0 ]; then
  green "Rundreise §6.4: dieselbe Sitzung, dasselbe Verzeichnis, die Entscheidung als nächste Nachricht — und ein Wiedereinstieg mitten in der Kette, der nicht neu plant ($(assertions) Zusicherungen im Lauf)"
else
  red 'die Rundreise aus §6.4 ist nicht nachgewiesen — siehe '"$LOG"
fi

# --- G2: the free-text answer -------------------------------------------------
headline 'G2 — der Freitextweg ist ebenso nachgewiesen'
g2=0
ran_green 'nimmt eine reine Freitextantwort genauso an' || g2=1
ran_green 'gibt des Betreibers eigene Worte wörtlich weiter — deutsch, im englischen Rahmen (§2)' || g2=1
ran_green 'sagt es, wenn keine Option gewählt wurde' || g2=1
if [ "$g2" = 0 ]; then
  green 'eine Antwort ohne gewählte Option wird eingespielt, wörtlich, und die Kette läuft damit bis zur Freigabe'
else
  red 'der Freitextweg ist nicht nachgewiesen — siehe '"$LOG"
fi

# --- G1: needs the operator's phone (A38) ---------------------------------------------
headline 'G1 — End-to-end auf einem echten Gerät (§22)'
if [ "$rt" = 0 ]; then
  defer 'ntfy-Push auf des Betreibers Telefon → Antwort in der PWA → dieselbe Sitzung läuft weiter' \
        'die Strecke von der Antwort bis zur fortgesetzten Sitzung ist oben nachgewiesen, Oberfläche und Benachrichtigung sind weiter unten in diesem Skript grün. Was fehlt, ist ausschließlich des Betreibers Gerät. Auf dem Produktionshost: infra/scripts/demo-phase4.sh --on-host'
else
  red 'die Strecke unterhalb des Geräts hält nicht — siehe '"$LOG"
fi

# --- §22 step 4: the outgoing channels, and the call sites nothing else sees --
headline '§22 Schritt 4 — ntfy und SMTP: der Verbraucher, den beide Dienste nicht hatten'
suite packages/core/src/escalation-push.itest.ts packages/core/src/escalation-mail.itest.ts \
      apps/orchestrator/src/notifications-pass.test.ts
n4=0
# §15: „ntfy push immediately on creation" — genau einmal, mit Deep-Link.
ran_green 'meldet eine neue Eskalation genau einmal — auch über drei Durchläufe' || n4=1
ran_green 'verlinkt auf die Karte, nicht auf die Liste (§15)' || n4=1
ran_green 'vermerkt einen abgelehnten Push nicht und versucht ihn erneut' || n4=1
ran_green 'schreibt deutschen Text mit der Nummer im Titel (§2, §15)' || n4=1
# A13: die beiden E-Mail-Regeln, mit gestellter Uhr.
ran_green 'schickt danach genau eine Erinnerung — und beim nächsten Durchlauf keine zweite' || n4=1
ran_green 'geht sofort raus, solange etwas offen ist — und dann genau einmal pro Tag' || n4=1
# Der Aufrufer selbst: ein Durchlauf, der nicht abbricht und nicht flutet.
ran_green 'bricht den Durchlauf nicht ab, wenn der E-Mail-Teil wirft — und pusht trotzdem' || n4=1
ran_green 'alarmiert genau einmal beim Übergang in den Fehlerfall — über zehn Durchläufe' || n4=1
ran_green 'verdrahtet jede Variable auf ihr eigenes Thema (§16)' || n4=1

# Und die Verdrahtung selbst, die kein Test sieht.
#
# `main.ts` hat keinen Test — genau das ist der Grund, warum `tick()` überhaupt
# ohne Aufrufer bleiben konnte (A71). Ein gelöschter Aufruf macht keine einzige
# Zusicherung oben rot: die Form, die hier repariert wird, versteckt sich in der
# Reparatur. Also wird die Aufrufstelle als Text geprüft — schwach, aber das
# einzige mechanische Netz, das es dafür gibt.
grep -q 'runNotificationsPass(' apps/orchestrator/src/main.ts || n4=1
grep -q 'topics: notifierTopics(config)' apps/orchestrator/src/main.ts || n4=1
# Und nur *ein* Produzent für den Inbox-Kanal: der Ad-hoc-Push in
# `reportBudgetAnomaly` ist entfernt worden (er trug keinen `clickUrl` und hätte
# jede Budgetkarte doppelt gemeldet). Kommt er zurück, ist das hier rot.
if grep -q "topic: 'inbox'" apps/orchestrator/src/main.ts; then n4=1; fi

if [ "$n4" = 0 ]; then
  green 'Push je Eintrag genau einmal mit Deep-Link · Erinnerung und Digest mit gestellter Uhr · ein Durchlauf, der weder abbricht noch flutet · die drei NTFY_TOPIC_*-Variablen wirken'
else
  red 'der ausgehende Kanal aus §22 Schritt 4 ist nicht nachgewiesen — siehe '"$LOG"
fi

# --- the browser half ---------------------------------------------------------
# §22 Schritt 2 lässt sich nicht mit vitest beweisen. Der Grund steht in A81:
# beide Hälften waren gegen ihre *eigene* Attrappe grün, während zwischen ihnen
# kein einziges Feld zusammenpasste — was fehlte, war eine Aufstellung, in der
# die Ausgabe der einen die Eingabe der anderen ist. Genau das tut ein Browser.
headline '§22 Schritt 2 — die Oberfläche gegen echte API und echte Datenbank'
E2E_LOG="${TMPDIR:-/tmp}/vorschicht-demo-phase4-e2e-$$.log"
if ./infra/scripts/with-test-db.sh pnpm exec playwright test --project=inbox \
     >"$E2E_LOG" 2>&1; then
  # Nur die eigenen Fälle zählen: `passkey` und `dashboard` laufen als erklärte
  # Abhängigkeiten davor, und ihre Fälle als Teil dieses Gates zu melden würde
  # aufblasen, was es belegt.
  green "Oberfläche: $(grep -cF '[inbox]' "$E2E_LOG") Fälle — deutsche Karte mit Optionen und genau einer Empfehlung · Antwort mit der Sitzung als Urheber · «blockiert durch Entscheidung #X» einmal je Aufgabe mit klickbarem Deep-Link · Zähler == gerenderte Zeilen · Protokoll mit Kontextverweisen"
else
  red 'die Oberflächen-Hälfte ist rot — siehe '"$E2E_LOG"
fi

# --- the three gates that closed with the phase --------------------------------
#
# Diese drei standen hier als `todo`, weil das Skript vor dem Phasenabschluss
# geschrieben wurde und danach niemand nachgezogen hat. In `CLAUDE.md` sind sie
# seit dem 2.8.2026 angehakt — ein Demo-Skript, das offen meldet, was die
# Spezifikation grün nennt, ist genau die Abweichung zwischen Behauptung und
# Beleg, die §8.2s erste Domäne sucht. Also prüft es jetzt, was sie behaupten.

headline 'G6 — Erinnerung und Digest mit gestellter Uhr; die Mail rendert in beiden Teilen'
suite packages/shared/src/mail.test.ts
g6=0
ran_green 'carries the number, the question and the deep link in BOTH parts' || g6=1
ran_green 'marks exactly the recommended option, in both parts' || g6=1
ran_green 'escapes markup in the HTML part and leaves the text part verbatim' || g6=1
ran_green 'is a complete HTML document, so a client has something to parse' || g6=1
ran_green 'lists every open item with its own link, in both parts' || g6=1
if [ "$g6" = 0 ]; then
  green 'HTML und Text tragen dieselben Tatsachen — Nummer, Frage, Deep-Link, genau eine markierte Empfehlung —, der HTML-Teil maskiert Markup und der Textteil nicht; die Zeitraffer-Fälle für Erinnerung und Digest sind oben grün gelaufen'
else
  red 'die Mail rendert nicht wie zugesagt — siehe '"$LOG"
fi

headline 'G8 — die Betriebsprüfung dieser Phase, mit ihrem Urteil'
# Der Bericht ist der dauerhafte Teil des Nachweises: die Datenbankzeile eines
# Handlaufs überlebt ihn nicht (A56), und seit A92 trägt jede Datei die Id der
# Prüfung, zu der sie gehört. Geprüft wird die Datei, nicht eine Erinnerung.
bericht=docs/pruefberichte/2026-08-02-67ac096c-gate_truth.md
if [ -f "$bericht" ] && grep -q 'phase_nicht_abschliessbar' "$bericht"; then
  green "Prüfbericht $bericht — Urteil phase_nicht_abschliessbar, ein gate_invalid gegen P0.G7 und zwei Defekte, alle drei im Watchdog, alle drei behoben und auf dem Produktionshost neu bewiesen (2026-08-02, 20:47)"
else
  red "der Prüfbericht dieser Phase fehlt oder trägt kein Urteil: $bericht"
fi

headline 'G7 — jede Entscheidung im Protokoll, mit voller Verknüpfung'
# Die Browser-Hälfte oben liest den Eintrag im Protokoll mit Frage, Antwort,
# Quelle und Projekt wieder; `inbox.itest.ts` pinnt die Kontextverweise eine
# Schicht tiefer, gegen eine echte Postgres.
suite apps/server/src/inbox.itest.ts
g7=0
ran_green 'trägt eine Antwort ins Entscheidungslog mit allen Kontextverweisen ein' || g7=1
if [ "$g7" = 0 ]; then
  green 'die Verknüpfung hält in beiden Schichten — im Browser gegen echte Zeilen (oben) und gegen eine echte Postgres hier'
else
  red 'die Verknüpfung im Entscheidungsprotokoll ist nicht nachgewiesen — siehe '"$LOG"
fi

printf '\n\033[1mErgebnis:\033[0m %d grün · %d verschoben · %d offen · %d rot\n' \
  "$pass" "$deferred" "$open" "$fail"
printf 'Protokoll: %s\n' "$LOG"
[ "$fail" = 0 ] || exit 1
