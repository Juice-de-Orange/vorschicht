#!/usr/bin/env bash
# =============================================================================
# Phase 8 — Controlling-Auswertung und Wochenbericht (§22).
#
#   infra/scripts/demo-phase8.sh [--on-host]
#
# §22 verlangt je Phase einen wiederholbaren Nachweis — „demo" heisst
# ausdrücklich nicht „eine Anekdote von Hand". Dieses Skript ist dieser
# Nachweis: es fährt die Zusicherungen hinter jedem Ausstiegs-Gate und druckt
# je Gate ein Urteil.
#
# **Am Anfang der Phase geschrieben, nicht an ihrem Ende** — dieselbe Wahl wie
# bei `demo-phase6.sh` und `demo-phase7.sh`, aus demselben Grund: fünf
# Behauptungen auf einmal von jemandem, der müde ist, sind das, woran P5.G8 und
# P6.G8 zwanzig Minuten nach dem Haken entwertet wurden. Hier steht, was heute
# nachweislich läuft; in `CLAUDE.md` steht, was die Phase behauptet, und dieses
# Skript setzt **keine Häkchen**.
#
# Zwei Eigenheiten dieser Phase, die den Aufbau bestimmen:
#
# **Zwei Gates hängen an einer Datenbank, die dieser Rechner nicht hat.** „from
# real operational data" und „reconciles with the event log" sind Aussagen über
# den **Betrieb**, nicht über eine Fixture. `check-kennzahlen.mjs` läuft
# deshalb gegen `DATABASE_URL`, und ohne eine endet es mit **2** — nichts
# geprüft ist nach A25/A50 keine Feststellung, und ein Skript, das daraus ein
# Rot machte, behauptete einen Befund, wo niemand hingesehen hat.
#
# **Und eine Zahl, die trivial stimmt, ist keine Bestätigung.** Solange kein
# schreibbares Projekt onboardet ist (A85), sind fünf der acht Kopfzahlen null
# und stimmen auf beiden Ableitungswegen überein, ohne etwas zu belegen.
# `check-kennzahlen.mjs` sagt das selbst („davon wirklich nachgerechnet: N von
# 6"), und dieses Skript reicht die Zeile durch, statt sie zu glätten.
#
# Exit: 0 = kein Gate ist rot · 1 = ein Gate, das halten sollte, hält nicht.
# Offene Gates lassen dieses Skript nicht scheitern; sie lassen es sagen, was
# noch fehlt.
# =============================================================================
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 2

ON_HOST=0
for arg in "$@"; do
  case "$arg" in
    --on-host) ON_HOST=1 ;;
    *) echo "unbekanntes Argument: $arg" >&2; exit 2 ;;
  esac
done

pass=0; fail=0; deferred=0; open=0
green()    { printf '  \033[32m[x]\033[0m %s\n' "$1"; pass=$((pass+1)); }
red()      { printf '  \033[31m[ ]\033[0m %s\n' "$1"; fail=$((fail+1)); }
defer()    { printf '  \033[33m[~]\033[0m %s\n       → %s\n' "$1" "$2"; deferred=$((deferred+1)); }
todo()     { printf '  \033[34m[ ]\033[0m %s\n       → %s\n' "$1" "$2"; open=$((open+1)); }
headline() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Ein Pfad **je Lauf** (A121.2): dieses Projekt hat mehrere Arbeitskopien, und
# ein geteiltes Protokoll hat schon einmal ein falsches Rot erzeugt.
LOG="${TMPDIR:-/tmp}/vorschicht-demo-phase8-$$.log"
: > "$LOG"

suite() {
  ./infra/scripts/with-test-db.sh ./node_modules/.bin/vitest run --reporter=verbose "$@" \
    >>"$LOG" 2>&1
}

# `sed` statt `grep -P`: `\e` ist eine GNU-Erweiterung (A128).
ESC=$(printf '\033')

ran_green() {
  sed "s/${ESC}\[[0-9;]*m//g" "$LOG" | grep -F "$1" | grep -q '^ *✓'
}

# Die Browserstrecke, einmal, für G4s zweite Hälfte. `gate:e2e` endet nach A25
# mit 2, wenn Docker oder ein Browser fehlt — dann ist nichts geprüft, und die
# Zeile sagt das, statt rot zu melden.
E2E_LOG="${TMPDIR:-/tmp}/vorschicht-demo-phase8-e2e-$$.log"
E2E_CODE=99
e2e_lauf() {
  [ "$E2E_CODE" != 99 ] && return
  printf 'Fahre die Browserstrecke (G4s Archivhälfte hängt daran) … '
  pnpm gate:e2e >"$E2E_LOG" 2>&1
  E2E_CODE=$?
  case "$E2E_CODE" in
    0) printf 'grün.\n' ;;
    2) printf 'nicht geprüft (Docker oder Browser fehlt).\n' ;;
    *) printf 'rot.\n' ;;
  esac
}

e2e_gruen() {
  e2e_lauf
  [ "$E2E_CODE" = 0 ] || return 1
  sed "s/${ESC}\[[0-9;]*m//g" "$E2E_LOG" | grep -F "$1" | grep -q '✓'
}

testfaelle() {
  sed "s/${ESC}\[[0-9;]*m//g" "$LOG" | grep -oE 'Tests +[0-9]+ passed' | tail -1 |
    grep -oE '[0-9]+' | head -1
}

printf '\033[1mPhase 8 — Controlling-Auswertung und Wochenbericht (§22)\033[0m\n'
[ "$ON_HOST" = 1 ] && printf 'Lauf auf dem Produktionshost.\n'

printf 'Baue die Pakete neu, damit die Suiten den Baum prüfen … '
if ! npx tsc --build --force >>"$LOG" 2>&1; then
  printf '\n'; red "der Build schlug fehl — siehe $LOG"
  printf '\n\033[1mErgebnis:\033[0m %d grün · %d verschoben · %d offen · %d rot\n' \
    "$pass" "$deferred" "$open" "$fail"
  exit 1
fi
printf 'fertig.\n'

# ── Die Fundamente, gemeinsam gefahren ──────────────────────────────────────
# Kennzahlen, Archivtabelle und Zeitplan in einem Lauf: sie teilen sich die
# Testdatenbank, und drei Aufrufe hiessen sie dreimal aufsetzen.
# `check-kennzahlen.itest.ts` gehört dazu, seit G2 zwei Hälften hat (A148): es
# prüft die **Rechnung** des Abgleichs, während der Betriebslauf die Datenquelle
# prüft.
# `report-pass.test.ts` gehört seit dem 25.8.2026 dazu, und sein Fehlen war ein
# Fund: G1 verlangt sechs Zusicherungen, zwei davon liegen dort (§16s Versandweg
# aus A150), und die Demo fuhr deren Datei **nicht** — also meldete sie **rot**
# über Zusicherungen, die im Gate grün sind. `demo-names.test.ts` (A128) konnte
# das nicht sehen: es prüft, dass ein Name im Repository existiert, nicht dass
# die Demo die Datei fährt, in der er steht.
suite packages/core/src/metrics packages/core/src/report packages/core/src/report-schedule.test.ts \
      apps/orchestrator/src/report-pass.test.ts \
      infra/scripts/check-kennzahlen.itest.ts
faelle_fundament="$(testfaelle)"

headline 'G1 — Bericht aus echten Betriebsdaten, deutsch, HTML und Klartext'
# Der Gate-Satz hat vier Teile. Drei sind belegt, der vierte — „renders in
# common mail clients" — braucht des Betreibers Mailkonto und sein Mailprogramm, ist also
# nach A38 verschoben statt offen. Was hier zusätzlich geprüft wird, ist die
# **Vorbedingung** dafür: dass die Fassung nicht in einer Bauform ankommt, von
# der bekannt ist, dass sie bricht (A150 — bis zum 25.8.2026 tat sie das).
if ran_green 'trägt genau die sechs Abschnitte, in der Reihenfolge der Spezifikation' &&
   ran_green 'zeigt jeden der sechs Abschnitte in beiden Darstellungen' &&
   ran_green 'trägt keinen `<style>`-Block und keine Klassen' &&
   ran_green 'stilisiert jedes sichtbare Element inline' &&
   ran_green 'stellt zu und schreibt genau dafür eine Zeile' &&
   ran_green 'archiviert und merkt sich den Bericht auch dann, wenn die Zustellung scheitert'; then
  defer "verschoben nach A38 — es fehlt SMTP in der .env des Produktionshosts und dein Mailprogramm" \
        "§22 Schritt 2. Belegt sind drei der vier Teile ($faelle_fundament Testfälle im gemeinsamen Lauf, davon 11 gegen echte Postgres): die sechs Abschnitte in der Reihenfolge der Spezifikation, deutsch, in HTML **und** Klartext. Dazu seit A150 der Versandweg und die Mailtauglichkeit der HTML-Fassung — kein <style> im <head>, keine Klassen, Tabellenlayout, jedes Element inline stilisiert; und ein gescheiterter Versand lässt den Bericht **nicht** neu erzeugen. Offen bleibt allein „renders in common mail clients\": dafür braucht es dein Mailkonto (SMTP_HOST/SMTP_FROM/REPORT_RECIPIENT) und deinen Blick darauf"
else
  red "Struktur, Mailtauglichkeit oder Versandweg sind nicht belegt — siehe $LOG"
fi

headline 'G2 — Abgleich: jede Kopfzahl gegen das Ereignisprotokoll nachgerechnet'
# Das eine Gate dieser Phase, das heute vollständig belegbar ist — aber nur
# gegen eine echte Datenbank. Ohne sie: nichts geprüft, nicht rot (A25).
#
# Zwei Hälften, und beide werden gebraucht (A148): die **Rechnung** an gesäten
# Daten, in denen alle sechs Zahlen ungleich null sind, und der Lauf gegen die
# **Betriebsdaten**. Der Produktionslauf allein trägt den Gate-Satz nicht —
# solange kein schreibbares Projekt onboardet ist (A85), sind fünf der sechs
# Zahlen beidseitig null, und `0 === 0` geht auch dann durch, wenn eine der
# beiden Ableitungen beliebig falsch rechnet.
if ran_green 'rechnet alle acht Kopfzahlen nach, und keine davon ist trivial' &&
   ran_green 'unterscheidet die drei Rollout-Ausgänge voneinander' &&
   ran_green 'endet mit 2 statt mit einem Urteil, wenn das Fenster leer ist'; then
  rechnung='alle sechs an gesäten Daten nachgerechnet (keine trivial), Fenster und Aufgaben-Entdopplung getrennt geprüft'
else
  rechnung=''
fi

if [ -z "${DATABASE_URL:-}" ]; then
  if [ -n "$rechnung" ]; then
    green "Rechnung: $rechnung — der Betriebslauf steht in der Belegzeile von P8.G2 (infra/scripts/kennzahlen-remote.sh --host <ssh-host>)"
  else
    todo 'die Rechnung ist nicht belegt' \
         'infra/scripts/check-kennzahlen.itest.ts braucht eine Testdatenbank (with-test-db.sh). Der Betriebslauf: infra/scripts/kennzahlen-remote.sh --host <ssh-host>'
  fi
else
  K_LOG="${TMPDIR:-/tmp}/vorschicht-demo-phase8-kennzahlen-$$.log"
  node infra/scripts/check-kennzahlen.mjs >"$K_LOG" 2>&1
  k_exit=$?
  k_zeile="$(sed "s/${ESC}\[[0-9;]*m//g" "$K_LOG" | grep -E 'check-kennzahlen: ' | head -1)"
  # Die Zeile über die trivialen Vergleiche wird **durchgereicht**, nicht
  # geglättet: ein grüner Lauf, in dem fünf von sechs Zahlen beidseitig null
  # sind, hat eine Zahl nachgerechnet und fünf nicht (A144.2).
  k_trivial="$(sed "s/${ESC}\[[0-9;]*m//g" "$K_LOG" | grep -E 'wirklich nachgerechnet' | head -1)"
  case "$k_exit" in
    0) green "${k_zeile:-Kopfzahlen stimmen überein}${k_trivial:+ — $(echo "$k_trivial" | sed 's/^ *//')}" ;;
    2) todo 'nicht geprüft' "Exit 2 heisst nichts geprüft, also kein Befund (A25). $K_LOG" ;;
    *) red "${k_zeile:-Abweichung} — siehe $K_LOG" ;;
  esac
fi

headline 'G3 — Längengrenze erzwungen (mit aufgeblähten Daten), keine Füllabschnitte'
# Vier Zusicherungen, und die dritte ist die, die man weglässt: dass die
# Kürzung **ausgeschrieben** wird. Eine Kürzung, die niemand sieht, liest sich
# wie ein vollständiger Bericht (A67.4). Und die vierte prüft die mechanische
# Schicht getrennt von der redaktionellen — sonst bewiese ein Lauf, in dem die
# Listen ohnehin kurz genug sind, nur, dass nichts passiert ist.
if ran_green 'hält aufgeblähte Daten unter der Grenze — und die redaktionelle Schicht reicht dafür' &&
   ran_green 'schreibt jede Kürzung aus, mit der Zahl der fehlenden Einträge' &&
   ran_green 'kürzt auch den einzelnen Eintrag, statt eine Zeile beliebig lang werden zu lassen' &&
   ran_green 'greift mechanisch, wenn die Grenze enger gesetzt wird, und sagt es' &&
   ran_green 'lässt keinen Abschnitt weg, wenn er leer ist — jeder sagt stattdessen etwas'; then
  green 'aufgeblähte Daten bleiben unter der Grenze, jede Kürzung wird ausgeschrieben (Liste, Einzeleintrag und die mechanische Schicht getrennt geprüft), und kein Abschnitt fällt weg, wenn er leer ist — §16.5 verlangt ausdrücklich, dass die Betriebsprüfung auch dann etwas sagt'
else
  red "eine der fünf Zusicherungen zur Längengrenze fehlt — siehe $LOG"
fi

headline 'G4 — Zeitplan Europe/Vienna samt Sommerzeit; Archiv zeigt Historie'
# Zwei Hälften, eine Zeile (A113). Die erste hält heute, die zweite nicht.
# Beide Umstellungen **und** der Abstand dazwischen. Die dritte Zusicherung ist
# die, die man weglässt: dass zwei Termine über eine Umstellung hinweg 167 bzw.
# 169 Stunden auseinanderliegen, ist genau die Rechnung, die ein fester
# Stundenversatz falsch macht — und der färbt „expected 2 to be 1" rot, weil
# der Herbst damit zweimal auslöst.
if ran_green 'setzt den Montag nach der Frühjahrsumstellung auf 05:00 UTC' &&
   ran_green 'setzt den Montag nach der Herbstumstellung auf 06:00 UTC' &&
   ran_green 'lässt über die Frühjahrsumstellung 167 Stunden zwischen zwei Terminen' &&
   ran_green 'lässt über die Herbstumstellung 169 Stunden zwischen zwei Terminen'; then
  zeitplan='in vier Fällen belegt'
else
  zeitplan='offen'
fi
# Die zweite Hälfte: das Archiv. Die Browserstrecke ist die einzige Stelle, an
# der „zeigt Historie" belegbar ist — zwei Wochen, die neuere zuerst, und der
# Volltext auf Klick. Ein Modultest über `ReportRecords.list` sagte nur, dass
# die Datenschicht sortiert.
if e2e_gruen 'zeigt beide Wochen, die neuere zuerst' &&
   e2e_gruen 'holt den Volltext erst auf Klick, und zeigt den Klartext statt der Mailfassung'; then
  archiv='Archiv zeigt zwei Wochen im Browser, neueste zuerst, Volltext auf Klick'
else
  archiv=''
fi

if [ -n "$archiv" ] && [ "$zeitplan" = 'in vier Fällen belegt' ]; then
  green "Zeitplan $zeitplan; $archiv"
else
  todo "Zeitplan $zeitplan, Archiv ${archiv:-fehlt oder nicht grün}" \
       '§22 Schritt 2. Die Sommerzeit-Hälfte ist die schwierige und steht: ein fester 60-Minuten-Versatz statt der Zeitzone färbt 19 von 26 Fällen rot, darunter „expected 2 to be 1" — der Herbst löst damit zweimal aus. Die Archivhälfte hängt an der Browserstrecke (`--project=berichte`)'
fi

headline 'G5 — Betriebsprüfung (§8.2) für diese Phase, Urteil aufgezeichnet'
# **Korrigiert am 25.8.2026.** Hier stand `defer` mit der Begründung „der Prüfer
# läuft strukturell nicht auf dieser Maschine" — und im selben Atemzug das
# Skript, das ihn fährt. A135 hat die Wand beschrieben *und* den Weg darum
# gebaut: `audit-remote.sh` fährt die Prüfung im Gate-Image auf dem Produktionshost,
# und Phase 7s Prüfung ist genau so gelaufen. Nach A38 ist ein Gate verschoben,
# wenn nur noch ein Artefakt des Zielhosts oder eine Handlung des Betreibers fehlt —
# beides trifft hier nicht zu. Es ist **offen**, also Arbeit.
todo 'nicht gelaufen' \
     '§22 Schritt 2. Die Prüfung gehört an den Phasenabschluss und ist nicht blockiert: infra/scripts/audit-remote.sh --host <ssh-host> --domain gate_truth --trigger phase_close --scope "Phase 8" --baum <pfad>. Sie kostet eine Sitzung der stärksten Stufe und braucht eine dauerhafte Prüfdatenbank (infra/scripts/audit-db.sh), damit ihre Folgen den Lauf überleben (A117)'

printf '\n\033[1mErgebnis:\033[0m %d grün · %d verschoben · %d offen · %d rot\n' \
  "$pass" "$deferred" "$open" "$fail"
printf 'Protokoll: %s\n' "$LOG"
[ "$fail" -gt 0 ] && exit 1
exit 0
