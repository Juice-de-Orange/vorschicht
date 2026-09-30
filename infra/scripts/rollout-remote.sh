#!/usr/bin/env bash
# Vorschicht auf den Produktionshost ausrollen — der Selbst-Deploy aus §12/A12.
#
#   infra/scripts/rollout-remote.sh --host <ssh-host> --freigabe "the operator, 18.8.2026, MC-Antwort"
#
# ## Warum git und nicht rsync
#
# Der Rollout war zunächst als `rsync -az --delete …` dokumentiert. Das hat am
# 9.8. funktioniert, weil er vom Produktionshost selbst gefahren wurde. Von der
# Baumaschine geht er nicht: **`rsync` gibt es dort nicht** (Git Bash), gemessen
# am 18.8.2026. Statt es nachzuinstallieren wird der Weg genommen, der ohnehin
# besser ist:
#
#   - **Kein `--delete`-Risiko.** Eine falsche Ausschlussliste löscht mit rsync
#     still fremde Dateien; `git reset --hard` fasst nur an, was git kennt.
#   - **`.git` überlebt konstruktionsbedingt**, statt auf einer Ausschlusszeile
#     zu beruhen. Das ist ein Pflichtpunkt, weil ohne `.git`
#     die Selbst-Onboarding-Prüfung namentlich verweigert und §8.2s Kadenz still
#     stehenbleibt.
#   - **`.env` überlebt ebenfalls**: sie ist unversioniert, und `reset --hard`
#     entfernt keine unversionierten Dateien. Das ist die eine Datei, deren
#     Verlust den Stack nicht mehr starten liesse.
#   - **Der ausgerollte Stand ist eine exakte sha**, nicht „was zufällig im
#     Arbeitsbaum lag". Das ist die Voraussetzung dafür, dass die
#     Release-Historie mit git abgeglichen werden kann (P5.G8).
#
# ## Was dieses Skript nicht ist
#
# Es ist **keine** Freigabe. A12 verlangt des Betreibers ausdrückliche Zustimmung für jeden
# Selbst-Deploy — „an autonomous system must not hot-swap its own brain
# unsupervised". `--freigabe` ist die Stelle, an der die Zustimmung *aufgeschrieben*
# wird; das Skript prüft nicht, ob sie echt ist, und tut auch nicht so. Ohne das
# Argument verweigert es, damit ein Rollout nie aus Versehen aus einer Schleife
# fällt.
#
# Exit: 0 ausgerollt und gesund · 1 ausgerollt und **nicht** gesund · 2 nichts getan.
set -euo pipefail

HOST="${VORSCHICHT_HOST:-}"
REMOTE_ROOT="${VORSCHICHT_REMOTE_ROOT:-/opt/vorschicht}"
FREIGABE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:-}"; shift 2 ;;
    --freigabe) FREIGABE="${2:-}"; shift 2 ;;
    *) echo "rollout: unbekanntes Argument „$1“." >&2; exit 2 ;;
  esac
done

if [ -z "$FREIGABE" ]; then
  cat >&2 <<'EOF'
rollout: keine Freigabe angegeben.

A12: ein Selbst-Deploy braucht **jedes Mal** des Betreibers ausdrückliche Zustimmung. Dieses
Skript prüft nicht, ob sie echt ist — es schreibt sie auf, damit im Nachhinein
feststeht, worauf sich der Rollout berief.

  infra/scripts/rollout-remote.sh --host <ssh-host> --freigabe "the operator, <Datum>, <wo gesagt>"
EOF
  exit 2
fi

if [ -z "$HOST" ]; then
  echo 'rollout: --host <ssh-host> fehlt (oder VORSCHICHT_HOST setzen).' >&2
  echo '  infra/scripts/rollout-remote.sh --host <ssh-host> --freigabe "…"' >&2
  exit 2
fi

echo "▶ Vorprüfung lokal"
if [ -n "$(git status --porcelain)" ]; then
  echo 'rollout: der Arbeitsbaum ist nicht sauber. Erst committen — der Produktionshost holt' >&2
  echo '  sich den Stand aus dem Remote, nicht aus diesem Verzeichnis.' >&2
  exit 2
fi
LOKAL="$(git rev-parse HEAD)"
git fetch -q origin
if [ "$LOKAL" != "$(git rev-parse origin/main)" ]; then
  echo 'rollout: HEAD und origin/main gehen auseinander. Erst pushen.' >&2
  echo "  lokal $(git rev-parse --short HEAD), origin $(git rev-parse --short origin/main)" >&2
  exit 2
fi
echo "  Arbeitsbaum sauber, HEAD = origin/main = $(git rev-parse --short HEAD)"

echo "▶ Ausrollen auf $HOST"
# **Der Freigabetext reist als base64, nicht als Argument.**
#
# `ssh host bash -s -- a b c` bewahrt **keine** Argumentgrenzen: alles nach dem
# Hostnamen wird zu einer Zeichenkette zusammengefügt und drüben von der Shell
# neu zerlegt. A135 hat das für den Prüfläufer aufgeschrieben; dieser Läufer
# hatte den Schutz nicht, und am 18.8.2026 hat es zugeschlagen — eine
# **Klammer** im Freigabetext, und die entfernte Shell brach mit
# „syntax error near unexpected token `('" ab, bevor irgendetwas geschah.
#
# Harmlos war das nur, weil der Rollout dadurch *gar nicht* lief. Die
# gefährliche Richtung ist die andere: ein Freigabetext mit `;` oder Backticks
# würde drüben als **Befehl** ausgeführt, und zwar in genau dem Skript, dessen
# einziger Zweck ist, A12s Freigabe festzuhalten. Der Text kommt von einem
# Menschen und wird wörtlich weitergereicht — er darf nie durch eine Shell.
FREIGABE_B64="$(printf '%s' "$FREIGABE" | base64 | tr -d '\n')"
ssh -o BatchMode=yes "$HOST" bash -s -- "$REMOTE_ROOT" "$LOKAL" "$FREIGABE_B64" <<'REMOTE'
set -eu
root="$1"; ziel="$2"; freigabe="$(printf '%s' "$3" | base64 -d)"
cd "$root"
vorher="$(git rev-parse --short HEAD)"

# Ein schmutziger Arbeitsbaum auf dem Server heisst, dass dort jemand von Hand
# gearbeitet hat. `reset --hard` würde das wegwerfen, ohne es zu zeigen.
if [ -n "$(git status --porcelain)" ]; then
  echo 'rollout: der Arbeitsbaum auf dem Server ist NICHT sauber:' >&2
  git status --short >&2
  echo '  Das wird nicht überschrieben. Erst ansehen, dann von Hand entscheiden.' >&2
  exit 2
fi

test -f .env || { echo 'rollout: keine .env auf dem Server — der Stack käme nicht hoch.' >&2; exit 2; }

git fetch -q origin
git reset -q --hard "$ziel"
nachher="$(git rev-parse --short HEAD)"
test -f .env || { echo 'rollout: .env ist beim Zurücksetzen verschwunden.' >&2; exit 1; }
test -d .git || { echo 'rollout: .git ist verschwunden.' >&2; exit 1; }
echo "  $vorher → $nachher (Freigabe: $freigabe)"

echo "▶ Stack neu bauen und starten"
docker compose -f infra/docker-compose.yml -f infra/docker-compose.override.yml \
  --env-file .env up -d --build
REMOTE

echo "▶ Gesundheit nachsehen (die Antwort kommt vom Server, nicht von mir)"
# 90 Sekunden, weil ein `--build` die Migrationen mitbringt und der Orchestrator
# beim Start seine Selbstprüfung fährt (§6.1).
ssh -o BatchMode=yes "$HOST" bash -s -- "$REMOTE_ROOT" <<'REMOTE'
set -eu
cd "$1"
for _ in $(seq 1 45); do
  ungesund="$(docker compose -f infra/docker-compose.yml -f infra/docker-compose.override.yml \
    --env-file .env ps --format '{{.Name}} {{.State}} {{.Health}}' 2>/dev/null |
    awk '$3 != "healthy" && $3 != "" { print }' || true)"
  laeuft="$(docker compose -f infra/docker-compose.yml -f infra/docker-compose.override.yml \
    --env-file .env ps --format '{{.Name}} {{.State}}' 2>/dev/null | awk '$2 != "running"' || true)"
  if [ -z "$ungesund" ] && [ -z "$laeuft" ]; then
    docker compose -f infra/docker-compose.yml -f infra/docker-compose.override.yml \
      --env-file .env ps --format '  {{.Name}} {{.State}} {{.Health}}'
    echo "  ausgerollter Stand: $(git rev-parse --short HEAD)"
    exit 0
  fi
  sleep 2
done
echo 'rollout: nicht alle Dienste sind binnen 90 s gesund geworden:' >&2
docker compose -f infra/docker-compose.yml -f infra/docker-compose.override.yml \
  --env-file .env ps --format '  {{.Name}} {{.State}} {{.Health}}' >&2
exit 1
REMOTE
