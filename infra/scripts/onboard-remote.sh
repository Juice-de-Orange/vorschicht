#!/usr/bin/env bash
# §20s Onboarding auf dem Host, auf dem das Studio läuft.
#
#   # 1. Trockenlauf — eine Sitzung der stärksten Stufe, schreibt nichts ins Ziel
#   infra/scripts/onboard-remote.sh --host <ssh-host> \
#     --repo /opt/example-app --slug example-app \
#     --name "Example App"
#
#   # 2. Der Betreiber liest den Vorschlag und die Karte im Posteingang
#
#   # 3. Übernehmen — **ohne** neue Sitzung, aus genau diesem Vorschlag
#   infra/scripts/onboard-remote.sh --host <ssh-host> --apply-lauf <runId> --actor <actor>
#
# ## Warum es dieses Skript gibt
#
# Bis zum 25.8.2026 fehlte ein Läufer dafür — `onboard.mjs` lief nur lokal,
# und lokal ist der falsche Ort. Beides stimmt, und der zweite Teil ist der
# wichtigere: `verifyCommand` prüft einen
# vorgeschlagenen Gate-Befehl gegen die **Manifeste des echten Baums**, und der
# liegt auf dem Produktionshost. Ein lokaler Lauf gegen einen anderen Auscheckstand prüft
# eine andere Datei.
#
# Dazu dieselben drei POSIX-Wände wie bei der Betriebsprüfung (A135): der
# `await import()`-Pfad (A130), `projects.root_path` (A131) und `buildRoleSettings`,
# das einen Hook-Pfad mit Backslashes verweigert — eine §6.6-Zusicherung, die
# nicht gelockert wird, damit ein Skript auf Windows läuft (§0.3).
#
# ## Zwei Einhängungen, und die zweite ist die, an der es sonst still bricht
#
# `onboard.mjs` benutzt `--path` **doppelt**: als Lesepfad für die Erhebung und
# als `rootPath`, der in der Projektzeile landet. Wird das Repository unter einem
# anderen Pfad eingehängt, als der Orchestrator es später sieht, entsteht eine
# Zeile, die auf ein Verzeichnis zeigt, das der Daemon nicht hat — und
# `WorktreeManager.ensure()` scheitert Tage später an etwas, das wie ein
# git-Fehler aussieht. Also wird das Pilot-Repo unter **genau** dem Containerpfad
# eingehängt: `/opt/x` → `/projects/x` (die Compose-Override-Datei bindet das
# Projektverzeichnis des Hosts nach `/projects`).
#
# Exit-Codes nach A25/A50:
#   0  Vorschlag steht (bzw. übernommen)
#   1  der Vorschlag ist nicht übernehmbar — ein Befund
#   2  infra — nichts geprüft
#   3  gar kein Vorschlag (die Sitzung lieferte nichts Verwertbares)
set -euo pipefail

HOST="${VORSCHICHT_HOST:-}"
REMOTE_ROOT="${VORSCHICHT_REMOTE_ROOT:-/opt/vorschicht}"
COMPOSE_NET="${VORSCHICHT_REMOTE_NET:-vorschicht_default}"
IMAGE="${VORSCHICHT_GATE_IMAGE:-vorschicht-gate:local}"
# Wo der Orchestrator die Projekte sieht. Kommt aus derselben Zeile wie in
# `docker-compose.yml` (VORSCHICHT_PROJECTS_ROOT) und ist hier nur der Präfix,
# unter dem eingehängt wird.
PROJECTS_ROOT="${VORSCHICHT_REMOTE_PROJECTS_ROOT:-/projects}"
TRANSCRIPTS="${VORSCHICHT_REMOTE_TRANSCRIPTS_DIR:-/srv/vorschicht/transcripts}"

REPO=""
ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

usage() {
  echo "  --host <ssh-host> ist Pflicht (oder VORSCHICHT_HOST setzen)." >&2
  echo "  Trockenlauf:  --host <ssh-host> --repo /opt/<x> --slug <x> --name \"…\" [--read-only]" >&2
  echo "                (--path setzt dieses Skript selbst: den Pfad, unter dem" >&2
  echo "                 der Orchestrator das Repository sieht.)" >&2
  echo "  Übernehmen:   --host <ssh-host> --apply-lauf <runId> --actor <actor>" >&2
}

if [ -z "$HOST" ]; then
  echo "onboard-remote: --host <ssh-host> fehlt." >&2
  usage
  exit 2
fi

if [ "$#" -eq 0 ]; then
  echo "onboard-remote: keine Argumente — sie gehen unverändert an onboard.mjs." >&2
  usage
  exit 2
fi

# Der Trockenlauf braucht das Repository; das Übernehmen liest nur das
# Ereignisprotokoll und fasst kein Verzeichnis an.
UEBERNAHME=0
for a in "$@"; do [ "$a" = "--apply-lauf" ] && UEBERNAHME=1; done

if [ "$UEBERNAHME" -eq 0 ] && [ -z "$REPO" ]; then
  echo "onboard-remote: --repo <pfad auf dem Host> fehlt (z. B. /opt/example-app)." >&2
  exit 2
fi
case "$REPO" in
  ""|/*) ;;
  *) echo "onboard-remote: --repo muss ein absoluter Pfad sein." >&2; exit 2 ;;
esac

if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" true 2>/dev/null; then
  echo "onboard-remote: „$HOST“ ist nicht per ssh erreichbar." >&2
  exit 2
fi

# Der Pfad, unter dem der Container das Repository sieht — und der in die
# Projektzeile geht. Siehe den Kopf: er muss dem entsprechen, was der
# Orchestrator später sieht.
CONTAINER_REPO=""
[ -n "$REPO" ] && CONTAINER_REPO="$PROJECTS_ROOT/$(basename "$REPO")"

echo "▶ Vorprüfung auf $HOST"
ssh -o BatchMode=yes "$HOST" bash -s -- "$REMOTE_ROOT" "$COMPOSE_NET" "$REPO" <<'REMOTE'
set -eu
root="$1"; net="$2"; repo="$3"
cd "$root" 2>/dev/null || { echo "onboard-remote: $root gibt es nicht." >&2; exit 2; }
command -v docker >/dev/null || { echo 'onboard-remote: kein docker auf dem Host.' >&2; exit 2; }
docker network inspect "$net" >/dev/null 2>&1 || {
  echo "onboard-remote: das Netz \"$net\" gibt es nicht — läuft der Stack?" >&2; exit 2; }
test -f .env || { echo "onboard-remote: $root/.env fehlt." >&2; exit 2; }
grep -q '^CLAUDE_CODE_OAUTH_TOKEN=' .env || {
  echo 'onboard-remote: kein CLAUDE_CODE_OAUTH_TOKEN in der .env.' >&2; exit 2; }
# Wie bei der Betriebsprüfung: `DATABASE_URL` steht nicht in der `.env`, sondern
# wird in `docker-compose.yml` zusammengesetzt. Sie hier nachzubauen wäre eine
# zweite Deklaration derselben Sache (A81); gelesen wird sie aus dem laufenden
# Orchestrator, was nebenbei prüft, dass der Stack läuft.
docker exec vorschicht-orchestrator-1 printenv DATABASE_URL >/dev/null 2>&1 || {
  echo 'onboard-remote: der Orchestrator läuft nicht oder kennt kein DATABASE_URL.' >&2
  exit 2; }
if [ -n "$repo" ]; then
  test -d "$repo/.git" || {
    echo "onboard-remote: $repo ist kein git-Repository." >&2
    echo '  Die Erhebung liest den Integrationszweig daraus; §10 schneidet jeden' >&2
    echo '  Aufgabenzweig davon ab, und ein geratener Standard wäre genau dort falsch.' >&2
    exit 2; }
  # Der Container läuft als der aufrufende Benutzer und liest nur — aber der
  # **Daemon** schreibt später als 10001 in `<repo>/.git/worktrees/`. Das ist
  # A58/A103s Falle an einer neuen Stelle, und sie zeigt sich sonst als Aufgabe,
  # die `queued` nie verlässt.
  besitzer="$(stat -c %u "$repo/.git")"
  if [ "$besitzer" != "10001" ]; then
    echo "onboard-remote: $repo/.git gehört uid $besitzer, nicht 10001." >&2
    echo "  Der Orchestrator läuft als 10001 und legt dort Worktrees an." >&2
    echo "  sudo chown -R 10001:10001 $repo" >&2
    exit 2
  fi
fi
echo "  Ausgerollt: $(git rev-parse --short HEAD), Netz $net, Stack läuft."
REMOTE

echo "▶ Gate-Image auf $HOST bauen (nach dem ersten Mal gecacht)"
ssh -o BatchMode=yes "$HOST" bash -s -- "$REMOTE_ROOT" "$IMAGE" <<'REMOTE'
set -eu
cd "$1"
docker build -q -f infra/docker/Dockerfile.gate -t "$2" infra/docker >/dev/null
REMOTE

echo "▶ Onboarding fahren"
# **`--path` wird hier gesetzt, nicht vom Aufrufer**, und das ist der Kern
# dieses Skripts. `onboard.mjs` benutzt den Wert doppelt: als Lesepfad für die
# Erhebung **und** als `rootPath`, der in der Projektzeile landet. Er muss also
# der Pfad sein, unter dem der **Orchestrator** das Repository später sieht —
# nicht der des Hosts, und nicht der einer beliebigen Einhängung. Wer ihn selbst
# mitgibt, kann eine Zeile erzeugen, die auf ein Verzeichnis zeigt, das der
# Daemon nicht hat; `WorktreeManager.ensure()` scheitert dann Tage später an
# etwas, das wie ein git-Fehler aussieht.
#
# Beim Übernehmen (`--apply-lauf`) entfällt er: dort wird kein Verzeichnis
# gelesen, und der Pfad kommt aus dem Vorschlag.
if [ -n "$CONTAINER_REPO" ]; then
  set -- "$@" --path "$CONTAINER_REPO"
fi

# `printf '%q'` plus base64: ssh bewahrt keine Argumentgrenzen, und ein `--name`
# mit Leerzeichen oder ein Semikolon in einer Prosa-Begründung zerfiele drüben
# in mehrere Anweisungen (audit-remote.sh hat das einmal gemessen).
ARGV_B64="$(printf '%q ' "$@" | base64 | tr -d '\n')"
set +e
ssh -o BatchMode=yes "$HOST" bash -s -- \
  "$REMOTE_ROOT" "$COMPOSE_NET" "$IMAGE" "$REPO" "$CONTAINER_REPO" "$TRANSCRIPTS" "$ARGV_B64" <<'REMOTE'
set -eu
root="$1"; net="$2"; image="$3"; repo="$4"; containerRepo="$5"; transkripte="$6"; argv_b64="$7"
eval "set -- $(printf '%s' "$argv_b64" | base64 -d)"
cd "$root"
db="$(docker exec vorschicht-orchestrator-1 printenv DATABASE_URL)"
token="$(grep '^CLAUDE_CODE_OAUTH_TOKEN=' .env | head -1 | cut -d= -f2-)"

# Das Sitzungsprotokoll über ein Zwischenverzeichnis (A150.7): der Container
# läuft als der aufrufende Benutzer, damit `docs/onboarding/<slug>.md` dem
# Repository gehört und nicht root — das Transkript-Volume gehört aber uid
# 10001. Eine Kennung kann nicht beides.
staging="$(mktemp -d "${TMPDIR:-/tmp}/vorschicht-onboard-transkripte-XXXXXX")"

# Das Pilot-Repo wird **nur** beim Trockenlauf eingehängt; die Übernahme liest
# das Ereignisprotokoll und fasst kein Verzeichnis an.
mounts=()
if [ -n "$repo" ]; then
  mounts+=(-v "$repo:$containerRepo:ro")
fi

set +e
# `</dev/null` und kein `-i`: der entfernte Teil kommt über `bash -s` und liest
# sein Skript von stdin; ein `docker run -i` frisst den Rest des Heredocs, und
# alles danach läuft nie (A150.10, dort einmal teuer bezahlt).
docker run --rm </dev/null \
  --network "$net" \
  --user "$(id -u):$(id -g)" \
  -v "$root":/work \
  -v "$staging":/data/transcripts \
  "${mounts[@]+"${mounts[@]}"}" \
  -w /work \
  -e HOME=/tmp \
  -e CI=true \
  -e DATABASE_URL="$db" \
  -e CLAUDE_CODE_OAUTH_TOKEN="$token" \
  -e VORSCHICHT_TRANSCRIPTS_ROOT=/data/transcripts \
  "$image" \
  bash -euo pipefail -c '
    # **`safe.directory`, und ohne diese Zeile war der erste Lauf wertlos.**
    #
    # Gemessen am 5.9.2026: die Erhebung meldete „Das Verzeichnis ist kein
    # git-Repository", der Vorschlag stand auf einer leeren Dateiliste — und
    # `verifyProposal` nannte trotzdem „übernehmbar", weil es *seine* Prüfungen
    # bestanden hatte. Ein Vorschlag, der auf nichts beruht und trotzdem
    # übernehmbar heisst, ist die teuerste Form dieses Fehlers.
    #
    # Ursache: der Container läuft als der **aufrufende** Benutzer (damit der
    # Vorschlag dem Repository gehört, A135.4), das Pilot-Repo gehört uid 10001
    # (weil der Daemon dort Worktrees anlegt) — und git verweigert eine fremde
    # Kennung mit `dubious ownership`. Die `safe.directory`-Ausnahme des Images
    # gilt hier nicht, weil `HOME=/tmp` die globale Konfiguration unsichtbar
    # macht. A127.5 ist derselbe Fall, eine Einhängung weiter.
    #
    # Geschrieben statt über `GIT_CONFIG_*` gesetzt: `git.ts` fährt jeden
    # git-Aufruf mit `GIT_CONFIG_NOSYSTEM=1`, und eine Konfiguration, die für
    # den geprüften Code unsichtbar ist, ist genau die Falle aus A127.4.
    git config --global --add safe.directory "*"

    if [ ! -d packages/core/dist ]; then
      pnpm install --frozen-lockfile >/dev/null 2>&1 || {
        echo "onboard-remote: pnpm install ist gescheitert." >&2; exit 2; }
      pnpm run gate:build >/dev/null 2>&1 || {
        echo "onboard-remote: der Baum liess sich nicht bauen." >&2; exit 2; }
    fi
    node infra/scripts/onboard.mjs "$@"
  ' -- "$@"
code=$?
set -e

# Die Sitzungsprotokolle ins Volume, das A14 sichert (§6.2, §18). Fail closed:
# klappt es nicht, wird gesagt, wo sie stattdessen liegen — statt still einen
# Vorschlag abzulegen, dessen Sitzung niemand mehr nachlesen kann.
if [ -n "$(ls -A "$staging" 2>/dev/null)" ]; then
  if sudo -n cp -r "$staging"/. "$transkripte"/ 2>/dev/null &&
     sudo -n chown -R 10001:10001 "$transkripte" 2>/dev/null; then
    echo "  Sitzungsprotokolle nach $transkripte gelegt."
    rm -rf "$staging"
  else
    echo "  ! Die Sitzungsprotokolle konnten nicht nach $transkripte gelegt werden." >&2
    echo "    Sie liegen in $staging — §18s Kette endet sonst an einem Lauf ohne Datei." >&2
  fi
else
  echo "  ! Kein Sitzungsprotokoll gefunden (bei --apply-lauf ist das richtig: keine Sitzung)."
fi
exit "$code"
REMOTE
code=$?
set -e

case "$code" in
  0) echo "▶ Fertig." ;;
  1) echo "▶ Der Vorschlag ist nicht übernehmbar (Befund)." >&2 ;;
  2) echo "▶ Nichts geprüft (infra)." >&2 ;;
  3) echo "▶ Kein Vorschlag — die Sitzung lieferte nichts Verwertbares." >&2 ;;
esac
exit "$code"
