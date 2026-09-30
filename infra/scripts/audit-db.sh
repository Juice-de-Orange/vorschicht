#!/usr/bin/env bash
# =============================================================================
# Die dauerhafte Datenbank der Betriebspruefung (§8.2, A117).
#
#   eval "$(infra/scripts/audit-db.sh)"      # setzt DATABASE_URL
#   infra/scripts/audit-db.sh --stop         # haelt sie an (Daten bleiben)
#   infra/scripts/audit-db.sh --entfernen    # loescht sie samt Volume
#
# Warum das hier steht und nicht `with-test-db.sh` genommen wird: jene Datenbank
# ist eine **Wegwerf**-Datenbank, und A117 verweigert einen echten Pruefungslauf
# genau dagegen. Der Grund ist nicht Ordnungsliebe, sondern §8.2s Arithmetik:
#
#   * Ein `coverage_gap` legt nach A65 **unbedingt** eine P2-Aufgabe an, ein
#     `gate_invalid` eine P1-Karte. Beides sind Schreibvorgaenge, und in einer
#     Wegwerf-Datenbank sind sie Sekunden spaeter fort, waehrend der Lauf Erfolg
#     meldet. Genau das ist am Phase-3-Abschluss passiert (A76): vier belegte
#     Funde verdampften und wurden nur gerettet, weil ein Mensch den
#     eingecheckten Bericht las.
#   * „Eine Ablehnung wird **genau einmal** wieder aufgemacht" ist
#     `count(*) FILTER (WHERE kind = 'dismissed')` ueber `audit_finding_events`.
#     Diese Zahl ist nur etwas wert, wenn sie **zwischen** Pruefungen ueberlebt.
#     Mit einer Datenbank je Lauf ist jede Ablehnung fuer immer die erste, und
#     der zweite Widerspruch — der nach §8.2 zum Betreiber gehen muss — kommt nie.
#
# Die Datenbank des ausgerollten Studios waere der bessere Ort, aber `db` hat
# nach §19 bewusst keine veroeffentlichten Ports. Bis die Funde ueber einen
# Rollout dorthin gelangen, ist dies die dauerhafte Haelfte; der eingecheckte
# Pruefbericht unter `docs/pruefberichte/` bleibt die andere.
#
# Exit: 0 = URL steht auf stdout · 2 = nichts eingerichtet (A25).
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."

NAME='vorschicht-audit-db'
VOLUME='vorschicht-audit-db-daten'
PASSWORT='audit-local-only'

if ! docker info >/dev/null 2>&1; then
  echo "audit-db: docker nicht erreichbar. Nichts eingerichtet (A25)." >&2
  exit 2
fi

case "${1:-}" in
  --stop)
    docker stop "$NAME" >/dev/null 2>&1 && echo "audit-db: angehalten, die Daten bleiben in $VOLUME." >&2
    exit 0
    ;;
  --entfernen)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker volume rm "$VOLUME" >/dev/null 2>&1 || true
    echo "audit-db: Container und Volume entfernt — die Pruefungshistorie ist damit weg." >&2
    exit 0
    ;;
esac

if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || echo false)" != 'true' ]; then
  if docker inspect "$NAME" >/dev/null 2>&1; then
    docker start "$NAME" >/dev/null
  else
    # Kein `--rm`: dieser Container soll seinen Lauf ueberleben. Das benannte
    # Volume ueberlebt zusaetzlich den Container selbst.
    docker run -d \
      --name "$NAME" \
      -e POSTGRES_USER=vorschicht \
      -e POSTGRES_PASSWORD="$PASSWORT" \
      -e POSTGRES_DB=vorschicht_audit \
      -e POSTGRES_INITDB_ARGS='--locale=C --encoding=UTF8' \
      -v "$VOLUME:/var/lib/postgresql/data" \
      -p '127.0.0.1:0:5432' \
      postgres:16-alpine >/dev/null
  fi
fi

PORT=$(docker port "$NAME" 5432/tcp | head -1 | sed 's/.*://')
if [ -z "$PORT" ]; then
  echo "audit-db: kein Port ermittelbar. Nichts eingerichtet (A25)." >&2
  exit 2
fi

URL="postgres://vorschicht:${PASSWORT}@127.0.0.1:${PORT}/vorschicht_audit"

for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U vorschicht -d vorschicht_audit >/dev/null 2>&1; then
    # Migrationen laufen bei jedem Aufruf: sie sind pruefsummengesichert und
    # idempotent, und eine Pruefung gegen ein veraltetes Schema liest Views,
    # die es noch nicht gibt.
    DATABASE_URL="$URL" pnpm db:migrate >&2
    echo "export DATABASE_URL='$URL'"
    exit 0
  fi
  sleep 0.5
done

echo "audit-db: die Datenbank kam nicht hoch. Nichts eingerichtet (A25)." >&2
exit 2
