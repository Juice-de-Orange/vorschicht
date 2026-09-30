#!/usr/bin/env bash
# =============================================================================
# §22 Phase 8, Gate 2: der Kennzahlen-Abgleich gegen die **Betriebsdaten**.
#
#   infra/scripts/kennzahlen-remote.sh --host <ssh-host> [-- <args fuer check-kennzahlen>]
#
# `check-kennzahlen.mjs` rechnet §16s Kopfzahlen ein zweites Mal und **anders**
# nach (rohe Zeilen, in JavaScript gezaehlt, eine Abfrage je Art). Was ihm fehlt,
# ist eine Datenbank mit echtem Betrieb darin — der Gate-Satz sagt „reconciles
# with the event log", und ein Ereignisprotokoll aus einer Fixture beweist, dass
# zwei Ableitungen ueber dieselben erfundenen Zeilen uebereinstimmen.
#
# ## Warum ein Tunnel und kein Lauf auf dem Host
#
# Das etablierte Muster (`audit-remote.sh`) faehrt das Gate-Image **auf**
# dem Produktionshost mit dem dortigen Baum. Fuer eine Modellsitzung ist das richtig; hier
# nicht, und der Grund ist gemessen: `/opt/vorschicht` hat **kein**
# `node_modules` und keine gebauten Pakete, `check-kennzahlen.mjs` importiert
# aber `packages/core/dist/metrics/index.js`. Ein Lauf dort hiesse `pnpm install`
# und `pnpm build` **im Produktionsbaum** — Schreibvorgaenge in dem Verzeichnis,
# aus dem der laufende Stapel gebaut wurde, fuer eine reine Lesefrage.
#
# Der Tunnel dreht es um: die Daten kommen zum Code statt der Code zu den Daten.
# Was auf dem Produktionshost passiert, ist ein `ssh -N` — kein Build, keine Datei, kein
# Container. Und geprueft wird der **aktuelle** Baum statt des ausgerollten,
# was hier das ehrlichere Ziel ist: die Frage lautet, ob die Ableitungen dieses
# Standes stimmen.
#
# ## Drei Riegel
#
#   1. **Nur an die Schleife gebunden.** `-L 127.0.0.1:<port>:<db-ip>:5432`
#      oeffnet nichts nach aussen; die Produktionsdatenbank ist waehrend des
#      Laufs von diesem Rechner erreichbar und von sonst niemandem.
#   2. **Der Port ist frei gewaehlt**, nicht 5432 — auf dieser Maschine laufen
#      andere Postgres-Container (A121s Klasse: ein fester Port ist eine
#      Kollision, die als Befund gelesen wird).
#   3. **Der Tunnel faellt immer**, auch wenn das Skript scheitert oder jemand
#      abbricht. Ein offener Tunnel zur Produktionsdatenbank, den niemand
#      bemerkt, ist schlimmer als ein fehlgeschlagener Lauf.
#
# Die Zugangsdaten werden **nie gedruckt** (§19): sie werden auf dem Produktionshost aus
# dem laufenden Orchestrator gelesen, hier nur in eine Variable gesetzt und an
# den Kindprozess gereicht.
#
# Exit: 0 = alles stimmt ueberein · 1 = eine Zahl weicht ab (Befund) ·
# 2 = nichts geprueft (A25/A50: Host unerreichbar, Stapel unten, kein Tunnel).
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.."

HOST="${VORSCHICHT_HOST:-}"
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:-}"; shift 2 ;;
    --) shift; ARGS=("$@"); break ;;
    *) ARGS+=("$1"); shift ;;
  esac
done

if [ -z "$HOST" ]; then
  echo "kennzahlen-remote: --host <ssh-host> fehlt (oder VORSCHICHT_HOST setzen). Nichts geprüft (A25)." >&2
  echo "  infra/scripts/kennzahlen-remote.sh --host <ssh-host> [-- <args fuer check-kennzahlen>]" >&2
  exit 2
fi

if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" true 2>/dev/null; then
  echo "kennzahlen-remote: „$HOST“ ist nicht per ssh erreichbar. Nichts geprüft (A25)." >&2
  exit 2
fi

# Beides in **einem** Aufruf, damit die Antworten zueinander passen: eine IP von
# vor einem Neustart und eine URL von danach wären zwei Zustände.
LAGE="$(ssh -o BatchMode=yes "$HOST" bash -s <<'REMOTE'
set -eu
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' vorschicht-db-1
docker exec vorschicht-orchestrator-1 printenv DATABASE_URL
REMOTE
)" || {
  echo "kennzahlen-remote: der Stapel antwortet nicht (db oder orchestrator unten). Nichts geprüft (A25)." >&2
  exit 2
}

DB_IP="$(printf '%s\n' "$LAGE" | sed -n '1p')"
DB_URL="$(printf '%s\n' "$LAGE" | sed -n '2p')"
if [ -z "$DB_IP" ] || [ -z "$DB_URL" ]; then
  echo "kennzahlen-remote: IP oder Verbindungszeichenkette nicht ermittelbar. Nichts geprüft (A25)." >&2
  exit 2
fi

# Riegel 2: ein freier Port, vom Kernel gewählt.
PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"

TUNNEL_PID=""
aufraeumen() {
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null
  return 0
}
trap aufraeumen EXIT INT TERM

# Riegel 1 und 3.
ssh -o BatchMode=yes -o ExitOnForwardFailure=yes \
    -N -L "127.0.0.1:${PORT}:${DB_IP}:5432" "$HOST" &
TUNNEL_PID=$!

for _ in $(seq 1 40); do
  if node -e "require('net').connect($PORT,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; then
    break
  fi
  sleep 0.25
done
if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
  echo "kennzahlen-remote: der Tunnel kam nicht hoch. Nichts geprüft (A25)." >&2
  exit 2
fi

# Host und Port der Verbindungszeichenkette auf den Tunnel umbiegen, Benutzer,
# Passwort und Datenbanknamen unverändert übernehmen.
LOKAL="$(printf '%s' "$DB_URL" | sed -E "s|@[^/]+/|@127.0.0.1:${PORT}/|")"

printf '\033[1mKennzahlen-Abgleich\033[0m gegen die Betriebsdaten auf %s\n' "$HOST"
printf '  Tunnel: 127.0.0.1:%s → %s:5432 (nur an die Schleife gebunden, fällt am Ende)\n\n' "$PORT" "$DB_IP"

DATABASE_URL="$LOKAL" node infra/scripts/check-kennzahlen.mjs "${ARGS[@]}"
exit $?
