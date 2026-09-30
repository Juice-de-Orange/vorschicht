#!/usr/bin/env bash
# =============================================================================
# Run any command of this repository inside the environment it assumes.
#
#   infra/scripts/in-container.sh pnpm gate
#   infra/scripts/in-container.sh infra/scripts/demo-phase6.sh
#   infra/scripts/in-container.sh pnpm exec vitest run packages/core/src/x.itest.ts
#
# This is `gate-in-container.sh`'s engine, lifted out when the demo scripts
# needed it too (A117 built it for the gate alone). The reasoning is unchanged
# and is written out there: a POSIX suite, a Windows checkout where not one of
# the nine gate steps starts, and 27 tests that assert `chmod 0600` and
# forward-slash paths because §6.6 and §19 are POSIX guarantees rather than
# accidents.
#
# What the caller gets:
#
#   * the working tree as it stands, streamed in — not `HEAD`, because a local
#     check that can only see committed work is useless before the commit;
#   * a Postgres neighbour, handed over as `VORSCHICHT_TEST_DB_URL`. The name is
#     deliberately not `TEST_DATABASE_URL`: that is what the tests themselves
#     read, and exporting it for a whole run makes the deliberately docker-free
#     unit step run the integration suite too (A61, A117.5);
#   * `node_modules` installed inside, against a named pnpm store volume — the
#     host's holds `@biomejs/cli-win32-x64` and is unusable here;
#   * Playwright's browsers in their own named volume, installed on first use by
#     the project's *own* playwright, so no version can drift from the lockfile.
#     Only their system libraries are baked into the image, because that half
#     needs apt and therefore root.
#
# Exit code is the command's own. This script uses 2 for the cases where nothing
# ran at all: docker missing, image build failed, database never ready (A25).
# =============================================================================
set -euo pipefail

# Git Bash rewrites anything that looks like a Unix absolute path before the
# process sees it, and docker arguments are full of them. Measured, because the
# symptom is silent: `-e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` arrived inside
# the container as `C:/Program Files/Git/ms-playwright`, so 300 MB of browsers
# downloaded into `/work/C:/Program Files/...` — inside the working tree, thrown
# away with the container, and re-downloaded on every run while the volume that
# exists for them stayed empty. Nothing failed; it just never worked.
#
# Every path in this script is a *container* path or a volume name, so there is
# nothing here that should be translated at all. On Linux the variable is unset
# and unread.
export MSYS_NO_PATHCONV=1

cd "$(dirname "$0")/../.."

if [ "$#" -eq 0 ]; then
  echo "in-container: kein Kommando angegeben." >&2
  echo "  infra/scripts/in-container.sh pnpm gate" >&2
  exit 2
fi

IMAGE_TAG="${GATE_IMAGE_TAG:-vorschicht-gate:local}"
STORE_VOL="${GATE_STORE_VOLUME:-vorschicht-gate-pnpm-store}"
BROWSER_VOL="${GATE_BROWSER_VOLUME:-vorschicht-gate-playwright}"
NET="vorschicht-run-net-$$"
PG="vorschicht-run-db-$$"
PGPASS="testdb-local-only"

cleanup() {
  docker rm -f "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if ! docker info >/dev/null 2>&1; then
  echo "in-container: docker nicht erreichbar." >&2
  exit 2
fi

echo "▶ Image bauen (nach dem ersten Mal gecacht)"
if ! docker build -q -f infra/docker/Dockerfile.gate -t "$IMAGE_TAG" infra/docker >/dev/null; then
  echo "in-container: Image-Bau fehlgeschlagen." >&2
  exit 2
fi

echo "▶ Postgres als Nachbarn starten"
docker network create "$NET" >/dev/null
docker run -d --rm \
  --name "$PG" \
  --network "$NET" \
  -e POSTGRES_USER=vorschicht \
  -e POSTGRES_PASSWORD="$PGPASS" \
  -e POSTGRES_DB=vorschicht_test \
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=512m \
  postgres:16-alpine \
  -c fsync=off -c full_page_writes=off -c synchronous_commit=off \
  >/dev/null

# Readiness over TCP and twice in a row — `with-test-db.sh` explains why at
# length, and the reason survives the move: the postgres entrypoint runs a
# temporary server during initdb that answers on the socket and then shuts down,
# so a single positive answer is not a promise about the server that follows.
ready=0
for _ in $(seq 1 120); do
  if docker exec "$PG" pg_isready -h 127.0.0.1 -p 5432 -U vorschicht -d vorschicht_test \
       >/dev/null 2>&1; then
    ready=$((ready + 1))
    [ "$ready" -ge 2 ] && break
  else
    ready=0
  fi
  sleep 0.5
done
if [ "$ready" -lt 2 ]; then
  echo "in-container: Postgres wurde nicht rechtzeitig bereit." >&2
  docker logs "$PG" 2>&1 | tail -20 >&2
  exit 2
fi

echo "▶ Arbeitsbaum übertragen und Kommando fahren"
# The file set is the one the secrets gate already uses, for the same reason: it
# is exactly what git can see, so nothing generated is examined and nothing
# tracked is missed. `.git` is appended as one more member of the *same* archive
# — two concatenated tar streams would need `--ignore-zeros`, and that also
# makes tar accept a truncated stream, which is the one failure a script that
# then reports results must not swallow.
{ git ls-files -co --exclude-standard -z; printf '.git\000'; } \
  | tar --null -cf - --files-from=- \
  | docker run -i --rm \
      --network "$NET" \
      -v "${STORE_VOL}:/pnpm-store" \
      -v "${BROWSER_VOL}:/ms-playwright" \
      -e CI=true \
      -e STORE_VOL_NAME="$STORE_VOL" \
      -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
      -e VORSCHICHT_TEST_DB_URL="postgres://vorschicht:${PGPASS}@${PG}:5432/vorschicht_test" \
      "$IMAGE_TAG" \
      bash -euo pipefail -c '
        # A named volume from an earlier root run keeps its ownership, and the
        # unprivileged user cannot write there. Say which volume, by name — the
        # alternative is pnpm failing several layers down with a path nobody
        # connects to a container that once ran as root.
        if ! touch /pnpm-store/.probe 2>/dev/null; then
          echo "in-container: /pnpm-store ist nicht beschreibbar." >&2
          echo "  Vermutlich ein Volume aus einem frueheren root-Lauf. Einmalig:" >&2
          echo "  docker volume rm ${STORE_VOL_NAME}" >&2
          exit 2
        fi
        rm -f /pnpm-store/.probe
        tar -x
        pnpm install --frozen-lockfile --store-dir /pnpm-store --reporter=silent

        # The browsers are installed by the projects own playwright, so the
        # binary always matches the lockfile and there is no second version to
        # keep in step. Only on first use: the volume outlives the container.
        #
        # A149: gefragt wird nach einem **ausfuehrbaren Browser**, nicht nach
        # einem nichtleeren Verzeichnis. Ein abgebrochener Download — hier: die
        # Platte lief waehrend `playwright install` voll — hinterlaesst
        # `/ms-playwright/.links`, und `ls -A` meldet daraufhin "installiert".
        # Die Folge war genau die, vor der A122 warnt: die Browserstrecke lief
        # nicht und meldete INFRA, also blockierte sie nichts, waehrend fuenf
        # angehakte Gates auf ihr ruhen. Eine Pruefung, die "installiert" nicht
        # von "halb installiert" unterscheidet, ist keine.
        if ! ls /ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux*/chrome-headless-shell >/dev/null 2>&1; then
          echo "▶ Playwright-Browser einmalig installieren"
          rm -rf /ms-playwright/.links
          pnpm exec playwright install chromium
        fi

        exec "$@"
      ' in-container "$@"
