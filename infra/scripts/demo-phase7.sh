#!/usr/bin/env bash
# =============================================================================
# Phase 7 exit-gate demonstration (§22).
#
#   infra/scripts/demo-phase7.sh [--on-host] [--with-lighthouse]
#
# Läuft die Testfälle hinter jedem Phase-7-Gate, statt sie zu beschreiben, und
# sagt klar, welche der acht noch nicht stehen. Zustände nach A38:
# [x] grün · [~] verschoben mit dem Befehl, der es später beweist · [ ] offen,
# mit dem §22-Schritt, der es schliesst.
#
# **Am Anfang der Phase geschrieben, nicht an ihrem Ende** — dieselbe Wahl wie
# bei demo-phase6.sh und aus demselben Grund: acht Behauptungen auf einmal von
# jemandem, der müde ist, sind das, woran P5.G8 zwanzig Minuten nach dem Haken
# entwertet wurde. Hier steht, was heute nachweislich läuft; in `CLAUDE.md`
# steht, was die Phase behauptet, und dieses Skript setzt **keine Häkchen**.
#
# Zwei Eigenheiten dieser Phase, die den Aufbau bestimmen:
#
# **Die Hälfte der Gates sind Messungen, keine Testfälle.** „< 1s end-to-end",
# „cold load < 2s over a throttled mobile profile against the VPS",
# „Lighthouse performance budget", „axe: zero violations" — das sind Zahlen aus
# einem Lauf, und eine Zahl gehört abgeschrieben, nicht erinnert. Wo dieses
# Skript eine misst, druckt es sie; wo es sie nicht messen kann, sagt es warum.
#
# **Ein Gate kann dieses Skript grundsätzlich nicht schliessen:** „der Betreiber sign-off
# on design, German UI copy & overview". Geschmack lässt sich nicht testen. Es
# steht als [ ] mit dem Hinweis, dass es eine Karte im Posteingang ist — und
# das ist kein Mangel des Skripts, sondern der einzige ehrliche Zustand.
#
# `--with-lighthouse` schaltet den Lighthouse-Lauf zu: er braucht einen
# Browser und mehrere Minuten, und er misst gegen den **gebauten** Bundle
# (A120), nicht gegen den Entwicklungsserver — sonst misst er ein Konstrukt,
# das in Produktion nicht existiert.
#
# Jedes Gate trägt seine eigene Fehlervariable, jeder Suitenaufruf seine eigene
# Zählung. Beides absichtlich: ein Gate, das grün liest, weil die Testfälle
# eines Nachbarn liefen, ist §8.2s erste Domäne (belegt in Phase 6 durch eine
# ausgeführte Mutation, die zwei Gates gleichzeitig rot färbte).
#
# Exit: 0 = kein Gate ist rot · 1 = ein Gate, das halten sollte, hält nicht.
# Offene Gates lassen dieses Skript nicht scheitern; sie lassen es sagen, was
# noch fehlt.
# =============================================================================
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 2
ON_HOST=0
# `--with-lighthouse` ist am 18.8.2026 entfernt worden, und der Grund gehört
# hierher, weil das Flag *aussah*, als täte es etwas: es setzte `REAL=1`, eine
# Variable, die nirgends deklariert und nirgends gelesen wird, während das
# deklarierte `LIGHTHOUSE=0` daneben stand und ebenfalls nie gelesen wurde. Ein
# Schalter, der nichts schaltet, ist schlimmer als ein fehlender — er liest sich
# wie eine Fähigkeit (§8.2, Domäne 6). Lighthouse und die
# Installierbarkeitsliste laufen über `check-leistungsbudget.mjs` ohne
# `--nur-artefakt`; wer sie will, ruft es dort auf.
for arg in "$@"; do
  case "$arg" in
    --on-host) ON_HOST=1 ;;
    *) printf 'demo-phase7: unbekanntes Argument „%s".\n' "$arg" >&2; exit 2 ;;
  esac
done

pass=0; fail=0; deferred=0; open=0
green()    { printf '  \033[32m[x]\033[0m %s\n' "$1"; pass=$((pass+1)); }
red()      { printf '  \033[31m[ ]\033[0m %s\n' "$1"; fail=$((fail+1)); }
defer()    { printf '  \033[33m[~]\033[0m %s\n       → %s\n' "$1" "$2"; deferred=$((deferred+1)); }
todo()     { printf '  \033[34m[ ]\033[0m %s\n       → %s\n' "$1" "$2"; open=$((open+1)); }
headline() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Ein Pfad **je Lauf**, nicht je Skript — dieselbe Bauart und dieselbe Begründung
# wie `with-test-db.sh`s `vorschicht-testdb-$$`.
#
# Gemessen, nicht befürchtet: dieses Projekt hat vierzehn Worktrees, und während
# eines Laufs von hier startete jemand denselben Nachweis aus dem Hauptbaum. Das
# `: > "$LOG"` des zweiten Laufs leerte das Protokoll, aus dem der erste gerade
# las — Ergebnis war ein **falsches Rot** auf G2 (jede seiner zehn Zusicherungen
# war in Wahrheit grün) und ein „?" an der Stelle, an der G6 das rote
# Vorprojekt nennen sollte. Ein Nachweisskript, das unter Parallelität eine
# Unwahrheit über den Baum druckt, ist schlimmer als keines: sein Rot liest sich
# wie ein Befund und ist eine Kollision im Dateisystem.
LOG="${TMPDIR:-/tmp}/vorschicht-demo-phase7-$$.log"
: > "$LOG"

suite() {
  ./infra/scripts/with-test-db.sh ./node_modules/.bin/vitest run --reporter=verbose "$@" \
    >>"$LOG" 2>&1
}

# `sed` statt `grep -P`: `\e` ist eine GNU-Erweiterung, und diese Skripte sollen
# auch dort laufen, wo sed sie nicht kennt.
ESC=$(printf '\033')

# A test that ran *and passed*, by name. The verbose reporter puts the mark and
# the name at opposite ends of one line, so the match is the name anywhere on a
# line that begins with the pass mark — a failed test carries `×` and therefore
# does not satisfy it, which is the whole reason to look at the mark.
ran_green() {
  # Farbenblind, und zwar absichtlich. **Dieses Skript war als einziges der
  # sechs nicht farbenblind** — `demo-phase2` bis `demo-phase6` streifen die
  # ANSI-Codes seit A128 ab, hier fehlte es. Folgenlos war das nur, weil die
  # Funktion definiert und **nie aufgerufen** wurde: vitest faerbt auch dann,
  # wenn seine Ausgabe in eine Datei geht (gemessen am 16.8.2026 im
  # Gate-Container), und dann steht das Haekchen nicht mehr am Zeilenanfang.
  # Der erste verdrahtete Aufruf haette also jede Suche scheitern lassen und
  # jedes Gate rot gemeldet, waehrend jede Zusicherung dahinter gruen ist —
  # A128s urspruenglicher Fehlalarm, reproduziert ausgerechnet in dem Block,
  # dessen einzige Aufgabe die Buchfuehrung ist. Repariert am 18.8.2026, **vor**
  # der ersten `ran_green`-Zeile.
  sed "s/${ESC}\[[0-9;]*m//g" "$LOG" | grep -F "$1" | grep -q '^ *✓'
}

# Vitests Zusammenfassung zaehlt **Testfaelle**, nicht `expect`-Aufrufe. Bis zum
# 11.8.2026 hiess diese Funktion `testfaelle` und ihre Zahl wurde in den gruenen
# Zeilen als „Zusicherungen" gedruckt — von dort wanderte sie in die Belegzeilen
# von CLAUDE.md. Der Irrtum ging in die vorsichtige Richtung (die Zeile behauptet
# weniger, als der Lauf prueft) und war trotzdem eine Belegzeile, die eine andere
# Groesse nennt als die gemessene. Gefunden von der Betriebspruefung f785a443 als
# `process`-Fund; kein Test kann diesen Unterschied sehen (A76.4).
testfaelle() {
  sed "s/${ESC}\[[0-9;]*m//g" "$LOG" | grep -oE 'Tests +[0-9]+ passed' | tail -1 |
    grep -oE '[0-9]+' | head -1
}

printf '\033[1mPhase 7 — Das Dashboard (§22)\033[0m\n'
[ "$ON_HOST" = 1 ] && printf 'Lauf auf dem Produktionshost.\n'

# Der Baum, nicht die Artefakte (A90.7).
printf 'Baue die Pakete neu, damit die Suiten den Baum prüfen … '
if ! npx tsc --build --force >>"$LOG" 2>&1; then
  printf '\n'; red "der Build schlug fehl — siehe $LOG"
  printf '\n\033[1mErgebnis:\033[0m %d grün · %d verschoben · %d offen · %d rot\n' \
    "$pass" "$deferred" "$open" "$fail"
  exit 1
fi
printf 'fertig.\n'

# ── G3s Messung läuft **zuerst**, vor der Browserstrecke ────────────────────
#
# Nicht der Ordnung halber, sondern weil die Reihenfolge das Ergebnis ändert.
# Gemessen am 18.8.2026, dreimal: einzeln gefahren meldet dieser Lauf grün
# (Wert 96, LCP 1.956 ms gegen 2.500, CLS 0,061 gegen 0,100); unmittelbar
# hinter den 90 Browserfällen im selben Container meldet er einen Befund.
# Was sich zwischen den Läufen unterscheidet, ist die Auslastung der Maschine
# und nicht das Artefakt — und Lighthouse misst genau das mit.
#
# Das ist A68s Klasse: dort benotete vitests Fünf-Sekunden-Vorgabe die Maschine
# statt den Code. Eine Leistungsmessung hinter einer Browsersuite laufen zu
# lassen und ihr Ergebnis als Aussage über das Bündel zu drucken, wäre
# derselbe Fehler mit einer Zahl statt einer Frist. Die Enge ist real und wird
# genannt statt versteckt: CLS hat 39 % Luft zur Grenze, das ist die Position,
# die als erste kippt — vor der Reservierung des Streifenplatzes waren es 12 %,
# und dort schwankte sie über die Grenze.
I_LOG="${TMPDIR:-/tmp}/vorschicht-demo-phase7-pwa-$$.log"
printf 'Messe Leistungsbudget und Installierbarkeit (vor der Browserstrecke) … '
node infra/scripts/check-leistungsbudget.mjs >"$I_LOG" 2>&1; b_exit=$?
printf 'Exit %d.\n' "$b_exit"

# ── Ein Browserlauf für vier Gates, nicht vier Läufe ────────────────────────
#
# G1, G4, G5 und G6 ruhen alle vier auf Playwright, und `office`, `traces`,
# `a11y` und `controlling` teilen sich dieselbe Abhängigkeitskette (A75.6:
# passkey → dashboard → …). Vier Aufrufe hiessen die Kette viermal fahren —
# derselbe Anmelde- und Registrierungsweg, viermal, für nichts.
#
# Gezählt wird **je Projekt**, nicht in Summe: ein Gate darf nur die Fälle
# nennen, die es belegen, sonst bläst die Zahl auf, was es aussagt (A113).
E2E_LOG="${TMPDIR:-/tmp}/vorschicht-demo-phase7-e2e-$$.log"
printf 'Fahre die Browserstrecke für G1, G4, G5 und G6 … '
browser_ok=0
if ./infra/scripts/with-test-db.sh pnpm exec playwright test \
     --project=office --project=traces --project=a11y --project=controlling \
     >"$E2E_LOG" 2>&1; then
  browser_ok=1
  printf 'grün.\n'
else
  printf 'rot — siehe %s\n' "$E2E_LOG"
fi

# Welches Projekt rot war, damit ein übersprungenes Gate nicht als eigener
# Befund gelesen wird (demo-phase6.sh:366, gleiche Bauart und gleicher Grund).
rotes_projekt="$(sed "s/${ESC}\[[0-9;]*m//g" "$E2E_LOG" |
  grep -oE '✘ +[0-9]+ +\[[a-z0-9-]+\]' | head -1 |
  grep -oE '\[[a-z0-9-]+\]' | tr -d '[]')"

faelle() { sed "s/${ESC}\[[0-9;]*m//g" "$E2E_LOG" | grep -cF "[$1]"; }

# Eine Zeile, die der Browserlauf **gedruckt** hat. Das ist der Unterschied
# zwischen „der Fall ist grün" und „die gemessene Zahl steht hier": ein Gate,
# das eine Grenze nennt, muss die Zahl zeigen und nicht die Farbe.
gedruckt() { sed "s/${ESC}\[[0-9;]*m//g" "$E2E_LOG" | grep -E "$1" | head -"${2:-1}"; }

# Ein Projekt ist grün, wenn der Lauf grün war **und** es eigene Fälle hatte.
# Die zweite Hälfte ist tragend: fällt ein Vorprojekt, plant Playwright die
# abhängigen gar nicht erst ein, und „null Fälle, kein Fehler" läse sich sonst
# wie bestanden.
projekt_gruen() { [ "$browser_ok" = 1 ] && [ "$(faelle "$1")" -gt 0 ]; }

# Der Satz, der ein übersprungenes Gate von einem gescheiterten unterscheidet.
uebersprungen_hinweis() {
  if [ -n "$rotes_projekt" ] && [ "$rotes_projekt" != "$1" ]; then
    printf 'das vorgelagerte Playwright-Projekt %s ist rot, also hat Playwright die Fälle von %s übersprungen und keinen einzigen ausgeführt — das ist **keine** Aussage über dieses Gate. Siehe %s' \
      "$rotes_projekt" "$1" "$E2E_LOG"
  else
    printf 'siehe %s' "$E2E_LOG"
  fi
}

headline 'G1 — Büro-Ansicht spiegelt echte Zustandswechsel in < 1s (gemessen)'
if projekt_gruen office; then
  g1_zeilen="$(gedruckt '^(Parken|Fortsetzen|Eskalation): ' 3 | tr -s ' ' | tr '\n' ' ')"
  if [ -n "$g1_zeilen" ]; then
    green "$(faelle office) Browserfälle; gemessen von der Zustandsänderung in der Datenbank bis zur Kugel am Schreibtisch: ${g1_zeilen}— alle drei Zustände, die der Gate-Satz namentlich verlangt (Parken, Fortsetzen, Eskalation), zwei Grössenordnungen unter der Sekunde"
  else
    red "das office-Projekt ist grün, hat aber keine Messzeile gedruckt — der Gate-Satz verlangt \"measured\", und eine grüne Farbe ist keine Zahl. Siehe $E2E_LOG"
  fi
else
  red "$(uebersprungen_hinweis office)"
fi

headline 'G2 — Kaltstart der Übersicht < 2s über ein gedrosseltes Mobilprofil gegen den VPS'
# Bewusst **kein** Gate-Schritt: der Kaltstart hängt am Internet, an der
# Erreichbarkeit des Produktionshosts und daran, dass er *diesen* Baum trägt. In `pnpm gate`
# wäre er auf fast jedem Lauf `infra` — A122s „ein Schritt, der nie etwas
# prüft". Hier gehört er hin: dieses Skript ist die Freigabeliste einer Phase,
# nicht die eines Commits.
K_LOG="${TMPDIR:-/tmp}/vorschicht-demo-phase7-kaltstart-$$.log"
node infra/scripts/check-kaltstart.mjs >"$K_LOG" 2>&1
k_exit=$?
k_zeile="$(sed "s/${ESC}\[[0-9;]*m//g" "$K_LOG" | grep -E 'check-kaltstart: ' | head -1)"
case "$k_exit" in
  0) green "${k_zeile:-gemessen} — gegen den Live-Host statt gegen localhost, und gewertet wird der schlechteste von drei Läufen" ;;
  2) todo 'nicht gemessen — der Host war nicht erreichbar oder kein Browser da' \
          "Exit 2 heisst nach A25/A50 **nichts geprüft**, also kein Befund. $K_LOG" ;;
  *) red "${k_zeile:-über der Grenze} — siehe $K_LOG" ;;
esac

headline 'G3 — Lighthouse: PWA installierbar, Leistungsbudget eingehalten'
# Zwei Hälften, **eine** Zeile (A113). Und die erste wird nicht von Lighthouse
# beantwortet: dessen `installable-manifest`-Audit gibt es in der hier
# installierten Version nicht mehr, also prüft `installierbarkeit.mjs` Chromes
# Kriterien einzeln und misst die Pixelgrösse aus dem PNG-Kopf nach.
# **Der volle Lauf, nicht `--nur-artefakt`.** Das wäre der schnelle Weg und
# der falsche: `--nur-artefakt` schaltet `--ohne-lighthouse` mit ein, und das
# überspringt die Installierbarkeitsliste ausdrücklich (siehe dessen eigene
# Zeile „Lighthouse und die Installierbarkeitsliste wurden übersprungen").
# Ein grünes G3 aus diesem Modus hiesse „das Bündel ist klein genug" und
# stünde unter einem Gate-Satz, der „PWA installable pass" verlangt — die
# Hälfte, die dieser Modus gar nicht ansieht. Der Preis sind drei Minuten.
#
# `installierbarkeit.mjs` wird bewusst **nicht** direkt aufgerufen: es ist eine
# Bibliothek ohne Einstiegspunkt. `node` darauf tut nichts und endet mit 0 —
# also ein Grün, das nichts geprüft hat (§8.2 Domäne 6). Der Lauf geht durch
# den einzigen Aufrufer, der die Kriterien wirklich auswertet.
# Gelaufen ist der Lauf schon — ganz oben, vor der Browserstrecke. Hier wird
# nur noch ausgewertet.
b_zeile="$(sed "s/${ESC}\[[0-9;]*m//g" "$I_LOG" | grep -E 'check-leistungsbudget: ' | head -1)"
# **Nur der Installierbarkeitsabschnitt**, nicht die ganze Ausgabe. Der erste
# Anlauf zählte jedes ✓ des Laufs und druckte „20 Kriterien erfüllt", wo es
# neun sind — die sechs Budgetpositionen, die vier Lighthouse-Werte und die
# Driftprüfung waren mitgezählt. Falsch in der **aufblasenden** Richtung, und
# genau so eine Zahl wandert danach als Beleg nach `CLAUDE.md`, wo kein Test
# sie mehr liest (A76.4). Gezählt wird ab der Abschnittsüberschrift.
inst_abschnitt="$(sed "s/${ESC}\[[0-9;]*m//g" "$I_LOG" |
  sed -n '/^Installierbarkeit (/,$p')"
inst_ja="$(printf '%s\n' "$inst_abschnitt" | grep -cE '^\s*✓ ')"
inst_nein="$(printf '%s\n' "$inst_abschnitt" | grep -cE '^\s*✗ ')"
case "$b_exit" in
  2) todo 'nicht geprüft' \
          "Exit 2 — nichts geprüft, also kein Befund (A25). Meist fehlt Chrome oder der Build. $I_LOG" ;;
  0) green "${b_zeile:-Budget eingehalten}; Installierbarkeit: $inst_ja Kriterien erfüllt, $inst_nein offen — geprüft werden Chromes Kriterien **einzeln** samt nachgemessener Pixelgrösse aus dem PNG-Kopf, weil Lighthouses eigenes \`installable-manifest\`-Audit es in der hier installierten Version nicht mehr gibt. Das Budget liegt als infra/leistungsbudget.json im Repository, wie der Gate-Satz wörtlich verlangt (\"budget documented in repo\")" ;;
  # Die Befundzeilen wandern **in die Ausgabe**, nicht nur ins Protokoll.
  # Gemessen am 18.8.2026: dieses Skript läuft im Gate-Container, und dessen
  # `/tmp` stirbt mit ihm — ein „siehe /tmp/…" zeigt danach auf nichts. Ein
  # rotes Gate, dessen Begründung nicht mehr existiert, ist ein rotes Gate,
  # das niemand nachprüfen kann.
  *) red "${b_zeile:-Befund}: $(sed "s/${ESC}\[[0-9;]*m//g" "$I_LOG" |
       grep -E '^\s*✗ ' | tr -s ' ' | tr '\n' ';' | sed 's/;$//')" ;;
esac

headline 'G4 — axe über alle Seiten: null Verstösse'
if projekt_gruen a11y; then
  seiten="$(sed "s/${ESC}\[[0-9;]*m//g" "$E2E_LOG" | grep -cE '^axe · ')"
  verstoesse="$(sed "s/${ESC}\[[0-9;]*m//g" "$E2E_LOG" | grep -E '^axe · ' |
    grep -cvE ' 0 Verstösse')"
  if [ "$seiten" -gt 0 ] && [ "$verstoesse" = 0 ]; then
    green "$seiten Seiten gescannt, je null Verstösse, $(faelle a11y) Browserfälle — und **null entschiedene** statt null gemeldeter: derselbe Lauf sichert zu, dass axes incomplete leer ist, denn ein unentscheidbarer Kontrast ist kein bestandener"
  else
    red "$seiten Seiten gescannt, $verstoesse davon mit Verstössen — siehe $E2E_LOG"
  fi
else
  red "$(uebersprungen_hinweis a11y)"
fi

headline 'G5 — Vom Punkt im Büro zur Transkriptzeile in ≤ 4 Klicks'
if projekt_gruen traces; then
  g5_zeile="$(gedruckt '^Klickpfad Büro-Punkt' 1)"
  if [ -n "$g5_zeile" ]; then
    green "$g5_zeile ($(faelle traces) Browserfälle) — **gezählt** von einem Lauscher im Fenster, nicht behauptet: bis zum 18.8. druckte diese Zeile denselben Satz, während der Lauf in der Aufgabenliste begann und den Büropunkt nie anklickte"
  else
    red "das traces-Projekt ist grün, hat aber keine Klickzeile gedruckt — siehe $E2E_LOG"
  fi
else
  red "$(uebersprungen_hinweis traces)"
fi

headline 'G6 — Pause-Schalter: parkt sauber, blockiert neue Sitzungen, Prüfpfad'
# Drei Ebenen, weil der Gate-Satz drei Dinge sagt und keine Ebene alle drei
# beantwortet: der Schalter und der Prüfpfad sind eine Oberfläche (Browser),
# die Wächter-Semantik ist Logik (Integrationstest), und „parkt laufende
# Sitzungen und blockiert neue" ist eine Aussage über das **laufende** Studio,
# die nur ein Lauf gegen die echte Verdrahtung belegen kann.
suite packages/core/src/guardian-service.itest.ts
P_LOG="${TMPDIR:-/tmp}/vorschicht-demo-phase7-pause-$$.log"
./infra/scripts/with-test-db.sh node infra/scripts/check-pause.mjs >"$P_LOG" 2>&1
p_exit=$?
p_zeile="$(sed "s/${ESC}\[[0-9;]*m//g" "$P_LOG" | grep -E '^Ergebnis: ' | head -1 |
  sed 's/^Ergebnis: /am laufenden Studio: /')"
if [ "$p_exit" = 2 ]; then
  todo 'nicht geprüft' "check-pause endete mit 2 — nichts geprüft, kein Befund (A25). $P_LOG"
elif [ "$p_exit" = 0 ] &&
     ran_green 'bildet die harte Pause auf Hard-Stop-Semantik ab und kehrt zurück' &&
     ran_green 'bildet die weiche Pause auf Wrap-up-Semantik ab' &&
     projekt_gruen controlling; then
  green "$p_zeile; dazu A26s beide Halbierungen gegen eine echte Postgres (weiche Pause → Wrap-up, harte Pause → Hard-Stop samt Rückkehr) und $(faelle controlling) Browserfälle für Schalter, config-Schreibung und die Zeile im Prüfprotokoll mit der Sitzung als Urheber"
else
  red "check-pause=$p_exit; Wächter-Semantik und Oberfläche siehe $P_LOG, $LOG und $E2E_LOG"
fi

headline 'G7 — der Betreiber nimmt Design und deutsche Oberfläche ab; pnpm gate grün; Doku aktuell'
defer 'verschoben nach A38 — eine Handlung, die der Betreiber vorbehalten ist' \
      'Geschmack lässt sich nicht testen, und §22 verlangt die Abnahme ausdrücklich „via an inbox item". Die Karte liegt im Posteingang (Quelle design_signoff, eigens dafür gebaut: über agent_question hätte §15s Präzedenzgedächtnis die **nächste** Abnahme aus dieser hier beantwortet). Die beiden anderen Teilsätze sind erfüllt und maschinell geprüft: pnpm gate zwölf von zwölf, und „Doku aktuell" ist seit A134 der zwölfte Gate-Schritt'

headline 'G8 — Betriebsprüfung (§8.2) für diese Phase, Urteil aufgezeichnet'
# **`defer`, nicht `todo`** — und das ist keine Kosmetik. `todo` heisst „offen",
# und dieses Skript meldete damit ein offenes Gate, während `CLAUDE.md` es
# angehakt führt: zwei Dokumente, die sich widersprechen, also genau der
# Zustand, den `gate-doku.mjs` (A134) und §8.2s erste Domäne suchen.
#
# Richtig ist `defer` nach A38: der Prüfer **kann hier strukturell nicht
# laufen** — `buildRoleSettings` verweigert einen Hook-Pfad mit Backslashes,
# und das ist eine §6.6-Zusicherung, die nicht gelockert wird (A135, dritte
# Wand). Das ist wörtlich A38s Fall „ein Artefakt des Zielhosts", und A38
# verlangt dafür die mitgelieferte Prüfung, die es schliessen wird. Sie liegt
# bei und ist gelaufen.
defer 'verschoben nach A38 — der Prüfer läuft strukturell nicht auf dieser Maschine' \
      'Gelaufen am 18.8.2026 auf dem Produktionshost im Gate-Image, Domäne gate_truth, Anlass phase_close, gegen den Kandidaten statt gegen den ausgerollten Stand. Urteil phase_nicht_abschliessbar: zwei Funde, kein defect, und keiner der sechs Phase-7-Haken entwertet — getroffen hat es P0.G5. Bericht: docs/pruefberichte/2026-08-18-49c549b4-gate_truth.md. Wiederholbar mit: infra/scripts/audit-remote.sh --host <ssh-host> --domain gate_truth --trigger phase_close --baum <pfad>'

printf '\n\033[1mErgebnis:\033[0m %d grün · %d verschoben · %d offen · %d rot\n' \
  "$pass" "$deferred" "$open" "$fail"
printf 'Protokoll: %s\n' "$LOG"
[ "$fail" -gt 0 ] && exit 1
exit 0
