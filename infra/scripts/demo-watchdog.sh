#!/usr/bin/env bash
# =============================================================================
# Watchdog demonstration (§22 Phase 0, gate 7 / §18.1).
#
#   infra/scripts/demo-watchdog.sh
#
# Two parts, and they answer two different questions.
#
#   A) Alarm-Drosselung — runs anywhere, needs no stack, no systemd, no sudo and
#      sends nothing. It drives the real `watchdog.sh` against stub `docker`,
#      `logger` and `curl` binaries and counts what actually reached the push
#      channel. This is the only way to observe "the second unhealthy run sends
#      nothing", because on the host that assertion costs two timer intervals
#      and a real push to the operator's phone per attempt.
#
#   B) P0.G7 auf dem Host — kills the orchestrator container and asserts that
#      the watchdog notices and *delivers* an ntfy alert within two timer
#      intervals, then makes exactly one restart attempt. Needs the host where
#      the timer is installed; restores the stack afterwards whatever happens,
#      because a demo that leaves the studio down is not a demo.
#
# Part B refuses with exit code 2 rather than 1 where it cannot run (A25, A99.6):
# nothing was checked, and "we could not look" must never read like "we looked
# and it was fine".
# =============================================================================
set -uo pipefail

HIER="$(cd "$(dirname "$0")" && pwd)"
WATCHDOG="$HIER/watchdog.sh"

STACK_DIR="${VORSCHICHT_STACK_DIR:-/opt/vorschicht}"
COMPOSE=(docker compose -f "$STACK_DIR/infra/docker-compose.yml"
         -f "$STACK_DIR/infra/docker-compose.override.yml"
         --env-file "$STACK_DIR/.env")
INTERVAL=120          # the timer runs every 2 minutes
BUDGET=$((INTERVAL * 2 + 30))
STATE_FILE=/var/lib/vorschicht/watchdog.state

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }

FEHLER=0
HOST_TEIL_LIEF=0
SANDKASTEN=''

aufraeumen() {
  if [ "$HOST_TEIL_LIEF" -eq 1 ]; then
    step 'Stack wiederherstellen'
    "${COMPOSE[@]}" up -d >/dev/null 2>&1
    sudo -n sh -c "echo ok > $STATE_FILE" 2>/dev/null || true
    sleep 5
    "${COMPOSE[@]}" ps --format 'table {{.Service}}\t{{.Status}}'
  fi
  [ -n "$SANDKASTEN" ] && rm -rf "$SANDKASTEN"
  return 0
}
trap aufraeumen EXIT

# =============================================================================
# Teil A — Alarm-Drosselung (A67.6, A86.5)
# =============================================================================
step 'Teil A: Alarm-Drosselung im Sandkasten (kein Stack, kein Push)'

SANDKASTEN="$(mktemp -d)"
BIN="$SANDKASTEN/bin"; mkdir -p "$BIN"
export STUB_LOG="$SANDKASTEN/syslog"
export STUB_PUSH="$SANDKASTEN/push"
: > "$STUB_LOG"; : > "$STUB_PUSH"

# The stub answers exactly the four docker questions watchdog.sh asks. Anything
# it does not know about is an error rather than a silent success, so a future
# check added to the watchdog fails here instead of being quietly unexercised.
cat > "$BIN/docker" <<'STUB'
#!/bin/sh
case "$1" in
  info) exit 0 ;;
  inspect)
    cid="$2"; fmt="$4"
    case "$fmt" in
      *State.Status*) echo running ;;
      *Health*)
        if [ "$cid" = 'cid-backup' ] && [ "${STUB_UNHEALTHY:-1}" = '1' ]
          then echo unhealthy
          else echo healthy
        fi ;;
      *) echo "stub: unbekanntes --format $fmt" >&2; exit 1 ;;
    esac
    exit 0 ;;
  exec) echo "$(date +%s)000"; exit 0 ;;
  compose)
    shift
    while [ $# -gt 0 ]; do
      case "$1" in -f|--env-file) shift 2 ;; *) break ;; esac
    done
    case "$1" in
      ps)    echo "cid-$3" ;;
      start) : ;;
      *)     echo "stub: unbekanntes compose $1" >&2; exit 1 ;;
    esac
    exit 0 ;;
esac
echo "stub: unbekanntes docker $1" >&2
exit 1
STUB

cat > "$BIN/logger" <<'STUB'
#!/bin/sh
printf '%s\n' "$3" >> "$STUB_LOG"
STUB

# Records one line per push, carrying the Title header — so the assertions can
# say *which* alert went out, not merely how many. The exit code is the whole
# point of the fixture: `curl -f` is what watchdog.sh reads to decide whether
# anything was delivered, and A86.5's rule hangs off exactly that.
cat > "$BIN/curl" <<'STUB'
#!/bin/sh
titel='(ohne Titel)'
while [ $# -gt 0 ]; do
  case "$1" in
    -H) case "$2" in Title:*) titel="${2#Title: }" ;; esac; shift 2 ;;
    *)  shift ;;
  esac
done
printf '%s\n' "$titel" >> "$STUB_PUSH"
[ "${STUB_CURL_FAIL:-0}" = '1' ] && exit 7
exit 0
STUB
chmod +x "$BIN/docker" "$BIN/logger" "$BIN/curl"

cat > "$SANDKASTEN/.env" <<'ENVFILE'
NTFY_SERVER=https://ntfy.example.invalid
NTFY_TOKEN=tk_stub
NTFY_TOPIC_ALERTS=vorschicht-alerts-sandkasten
ENVFILE

lauf() {  # $1 = 1 wenn backup ungesund, $2 = 1 wenn ntfy ablehnt
  PATH="$BIN:$PATH" \
  STUB_UNHEALTHY="$1" STUB_CURL_FAIL="$2" \
  VORSCHICHT_STACK_DIR="$SANDKASTEN" \
  VORSCHICHT_ENV_FILE="$SANDKASTEN/.env" \
  VORSCHICHT_WATCHDOG_STATE="$SANDKASTEN/state/watchdog.state" \
    bash "$WATCHDOG" >> "$SANDKASTEN/stdout" 2>> "$SANDKASTEN/stderr"
}
pushes()   { wc -l < "$STUB_PUSH" | tr -d ' '; }
# `grep -c` prints a 0 *and* exits 1 when nothing matches, so `|| echo 0` would
# answer "0\n0" — counted through `wc` instead, which has one failure mode less.
versuche() { grep 'single restart attempt' "$SANDKASTEN/state/watchdog.audit.log" 2>/dev/null | wc -l | tr -d ' '; }
phase()    { cut -d' ' -f1 < "$SANDKASTEN/state/watchdog.state" 2>/dev/null || echo '(keine)'; }
letzter()  { tail -1 "$STUB_PUSH" 2>/dev/null || echo '(keiner)'; }

pruefe() {  # Beschreibung, erwartet, tatsächlich
  if [ "$2" = "$3" ]; then ok "$1"
  else bad "$1 — erwartet «$2», war «$3»"; FEHLER=$((FEHLER + 1)); fi
}

# --- Fall 1: Eintritt --------------------------------------------------------
lauf 1 0
pruefe 'Eintritt: genau ein Push'                    1 "$(pushes)"
pruefe 'Eintritt: Titel nennt den Ausfall'           'Vorschicht: Stack ungesund' "$(letzter)"
pruefe 'Eintritt: genau ein Startversuch (A23)'      1 "$(versuche)"
pruefe 'Eintritt: Zustand steht auf failing'         'failing' "$(phase)"

# --- Fall 2: zweiter ungesunder Lauf ----------------------------------------
# Der tragende Fall dieser Änderung. Vorher: ein Push je Lauf, alle zwei
# Minuten, sieben Tage lang.
lauf 1 0
pruefe 'Zweiter Lauf: kein weiterer Push'            1 "$(pushes)"
pruefe 'Zweiter Lauf: kein zweiter Startversuch'     1 "$(versuche)"

# --- Fall 3: kurz vor der Frist ---------------------------------------------
# Der Zeitstempel wird auf „vor fünf Stunden" zurückgesetzt, damit die echte
# Sechs-Stunden-Konstante geprüft wird und nicht eine Testvariante davon.
sed -i "s/ [0-9]*\$/ $(( $(date +%s) - 5 * 3600 ))/" "$SANDKASTEN/state/watchdog.state"
lauf 1 0
pruefe 'Nach 5h: noch keine Erinnerung'              1 "$(pushes)"

# --- Fall 4: Erinnerung nach sechs Stunden ----------------------------------
sed -i "s/ [0-9]*\$/ $(( $(date +%s) - 7 * 3600 ))/" "$SANDKASTEN/state/watchdog.state"
lauf 1 0
pruefe 'Nach 7h: genau eine Erinnerung'              2 "$(pushes)"
pruefe 'Nach 7h: Titel nennt die Dauer der Störung'  'Vorschicht: Stack weiterhin ungesund' "$(letzter)"
pruefe 'Nach 7h: immer noch nur ein Startversuch'    1 "$(versuche)"

lauf 1 0
pruefe 'Direkt danach: wieder Ruhe'                  2 "$(pushes)"

# --- Fall 5: Erholung --------------------------------------------------------
lauf 0 0
pruefe 'Erholung: genau ein Push'                    3 "$(pushes)"
pruefe 'Erholung: Titel meldet die Entwarnung'       'Vorschicht: Stack wieder gesund' "$(letzter)"
pruefe 'Erholung: Zustand steht wieder auf ok'       'ok' "$(phase)"

lauf 0 0
pruefe 'Gesund bleiben meldet nichts'                3 "$(pushes)"

# --- Fall 6: ntfy geht mit der Störung unter ---------------------------------
# A86.5 wörtlich: der Zustand kippt nur bei zugestelltem Alarm — ein ntfy, das
# mit der Störung untergegangen ist, muss es erneut versuchen statt „gemeldet"
# zu vermerken. Und **trotzdem** bleibt es bei einem Startversuch je Störung,
# weil Phase und Zustellung getrennte Felder sind: hinge der Riegel an der
# Zustellung, verlängerte ein ntfy-Ausfall genau das Neustart-Karussell, das A23
# verbietet und das P0.G7s Belegzeile ausschließt.
#
# Achtung beim Lesen der Zahlen: `versuche()` zählt über die **ganze** Demo,
# und Fall 5 hat die erste Störung beendet. Was hier beginnt, ist eine zweite
# Störung — die Gesamtzahl 2 ist also ein Versuch je Störung, nicht zwei
# innerhalb einer. Die Zusicherung, die A23 hier wirklich hält, ist die dritte:
# die Zahl bewegt sich über weitere ungesunde Läufe nicht mehr.
lauf 1 1
pruefe 'ntfy abweisend: Versuch gelaufen'                   4 "$(pushes)"
pruefe 'neue Störung: ein eigener Startversuch (gesamt 2)'  2 "$(versuche)"
lauf 1 1
pruefe 'ntfy abweisend: erneuter Versuch statt Ruhe'        5 "$(pushes)"
pruefe 'kein zweiter Startversuch in dieser Störung (A23)'  2 "$(versuche)"
lauf 1 0
pruefe 'ntfy zurück: der Alarm kommt an'                    6 "$(pushes)"
lauf 1 0
pruefe 'danach gedrosselt wie üblich'                       6 "$(pushes)"
pruefe 'und der Riegel hält weiter (A23)'                   2 "$(versuche)"

# --- Fall 7: Altbestand im alten Format -------------------------------------
# Der Zustand hatte bis zu dieser Änderung genau ein Feld. Beim Ausrollen liegt
# auf dem Produktionshost ein nacktes `failing` (die Störung, die diese Drosselung
# ausgelöst hat), und das ist keine hypothetische Eingabe, sondern die, die der
# erste Lauf nach dem Deploy wirklich vorfindet: `seit` und `gemeldet` sind dann
# unbekannt. Unbekannt heißt „noch nichts zugestellt", also **einmal** melden und
# danach drosseln — nicht schweigen (die Störung läuft ja) und nicht neu starten
# (der Riegel ist gefallen).
printf 'failing\n' > "$SANDKASTEN/state/watchdog.state"
lauf 1 0
pruefe 'Altformat «failing»: einmal melden'                 7 "$(pushes)"
pruefe 'Altformat: kein Startversuch mehr'                  2 "$(versuche)"
lauf 1 0
pruefe 'Altformat: danach gedrosselt'                       7 "$(pushes)"

# --- Fall 8: die Ausgangslage von Teil B ------------------------------------
# Teil B schreibt `echo ok > state` und killt dann den Orchestrator. Genau diese
# Vorbedingung wird hier gefahren, damit P0.G7 nicht an einem Parser scheitert,
# den lokal nichts anfasst — der Host-Teil läuft nur auf dem Produktionshost, und ein
# Nachweis, der erst dort rot wird, ist einer zu spät.
printf 'ok\n' > "$SANDKASTEN/state/watchdog.state"
lauf 1 0
pruefe 'Altformat «ok» = Teil-B-Ausgangslage: Alarm'        8 "$(pushes)"
pruefe 'Teil-B-Ausgangslage: Titel wie in P0.G7'            'Vorschicht: Stack ungesund' "$(letzter)"
pruefe 'Teil-B-Ausgangslage: genau ein Startversuch'        3 "$(versuche)"
pruefe 'Teil-B-Ausgangslage: Zustand auf failing'           'failing' "$(phase)"

if [ "$FEHLER" -ne 0 ]; then
  bad "Teil A: $FEHLER Zusicherung(en) verletzt"
  printf '\n--- syslog ---\n'; cat "$STUB_LOG"
  printf '\n--- pushes ---\n'; cat "$STUB_PUSH"
  exit 1
fi
ok 'Teil A vollständig grün — 1 Eintritt, 1 Erinnerung je 6h, 1 Entwarnung'

# =============================================================================
# Teil B — P0.G7 auf dem Host
# =============================================================================
step 'Teil B: Ausfallalarm auf dem Host (P0.G7)'

if ! systemctl is-active vorschicht-watchdog.timer >/dev/null 2>&1; then
  bad 'vorschicht-watchdog.timer ist nicht aktiv — Teil B nicht geprüft.'
  printf '  Dieser Lauf belegt die Drosselung und NICHT P0.G7.\n'
  printf '  Auf dem Produktionshost ausführen: infra/scripts/demo-watchdog.sh\n'
  exit 2
fi
HOST_TEIL_LIEF=1
ok "Timer aktiv, Intervall $(systemctl show vorschicht-watchdog.timer -p TimersMonotonic --value | head -c 80)"

step 'Ausgangslage'
sudo -n sh -c "echo ok > $STATE_FILE"
# Der Zeitstempel ist der Anker, und er wird auch benutzt.
#
# Vorher stand hier eine Zeilenzahl, die nie gelesen wurde, und die Suche unten
# lief über ein Fenster von fünf Minuten — ein zweiter Lauf innerhalb dieser
# Zeit meldete „erkannt" anhand der Journal-Zeile des *vorigen* Laufs. Ein
# Nachweis, der ohne den Kill grün wird, weist nichts nach. Gefunden von der
# Betriebsprüfung.
SEIT="$(date '+%Y-%m-%d %H:%M:%S')"
sleep 1
printf '  Journal wird ab %s gelesen\n' "$SEIT"

step 'Orchestrator hart killen (SIGKILL)'
CID="$("${COMPOSE[@]}" ps -q orchestrator | head -1)"
[ -n "$CID" ] || { bad 'Orchestrator-Container nicht gefunden'; exit 1; }
docker kill --signal=KILL "$CID" >/dev/null
# `stop` as well, otherwise compose's restart policy revives it before the
# watchdog ever gets a chance to notice — which would demonstrate nothing.
"${COMPOSE[@]}" stop orchestrator >/dev/null 2>&1
ok 'Container gestoppt'

step "Warte auf den Watchdog (max ${BUDGET}s = 2 Intervalle + Reserve)"
DEADLINE=$(( $(date +%s) + BUDGET ))
DETECTED=0
ZUGESTELLT=0
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  JOURNAL="$(sudo -n journalctl -t vorschicht-watchdog --since "$SEIT" --no-pager 2>/dev/null)"
  if printf '%s' "$JOURNAL" | grep -q 'Stack ungesund'; then
    DETECTED=1
    # Der Gate-Satz heißt „ntfy-Alarm", nicht „Zeile im Journal". Die
    # Erkennungszeile schreibt der Watchdog **vor** dem Push und unabhängig
    # davon — sie war grün, wenn ntfy gar nicht konfiguriert oder unerreichbar
    # war. Deshalb ist die tragende Zusicherung die Zustellung selbst.
    printf '%s' "$JOURNAL" | grep -q 'ntfy: Alarm an .* zugestellt' && ZUGESTELLT=1
    [ "$ZUGESTELLT" -eq 1 ] && break
  fi
  sleep 5
  printf '.'
done
printf '\n'

if [ "$DETECTED" -eq 0 ]; then
  bad "kein Alarm innerhalb von ${BUDGET}s"
  exit 1
fi
ok 'Watchdog hat den Ausfall erkannt'

if [ "$ZUGESTELLT" -eq 1 ]; then
  ok 'ntfy hat den Alarm angenommen — das ist der Satz, den P0.G7 behauptet'
else
  bad 'Ausfall erkannt, aber ntfy hat den Alarm nicht angenommen — genau der Fall,
       den die alte Prüfung für grün hielt (siehe Journal unten)'
  sudo -n journalctl -t vorschicht-watchdog --since "$SEIT" --no-pager 2>/dev/null | tail -6
  exit 1
fi
sudo -n journalctl -t vorschicht-watchdog --since "$SEIT" --no-pager 2>/dev/null | tail -4

step 'Genau ein Neustartversuch (A23)'
ATTEMPTS="$(sudo -n grep -c 'single restart attempt' /var/lib/vorschicht/watchdog.audit.log 2>/dev/null || echo 0)"
printf '  Protokollierte Startversuche insgesamt: %s\n' "$ATTEMPTS"
# Die Zustandsdatei trägt seit der Drosselung drei Felder (`failing <seit>
# <gemeldet>`); geprüft wird das erste, weil A23s Aussage über die Phase geht.
PHASE_JETZT="$(sudo -n cut -d' ' -f1 "$STATE_FILE" 2>/dev/null || echo '(unlesbar)')"
if [ "$PHASE_JETZT" = 'failing' ]; then
  ok 'Zustand steht auf "failing" — weitere Läufe alarmieren nur noch, ohne Neustart'
else
  bad "Zustandsdatei zeigt nicht \"failing\", sondern «$PHASE_JETZT»"
  exit 1
fi
