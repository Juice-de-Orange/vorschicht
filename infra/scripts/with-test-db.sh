#!/usr/bin/env bash
# =============================================================================
# Run a command against a throwaway Postgres.
#
#   infra/scripts/with-test-db.sh pnpm vitest run
#
# Starts a disposable postgres:16-alpine container, waits for it to be ready,
# exports TEST_DATABASE_URL, runs the command, and removes the container again
# no matter how the command exits. Integration tests skip themselves when the
# variable is absent, so `pnpm gate` still passes on a bare checkout — this
# script is what makes them actually run.
#
# The container name is unique per invocation so a crashed previous run cannot
# leave a poisoned database behind for the next one.
# =============================================================================
set -euo pipefail

# An already-provided database is used as it stands.
#
# This is what lets the suite run somewhere that has a Postgres but no docker
# client — `gate-in-container.sh` starts one as a sibling and hands the URL in,
# and the same door fits a CI runner with a service container. Without it the
# only way to reach the integration tests is a machine that can start
# containers, which is a stronger requirement than the tests actually have.
#
# Deliberately no health check here: whoever set the variable owns the database,
# and a second opinion about somebody else's server is a failure mode, not a
# safeguard. Below, where this script owns the container, it checks twice.
# A database provided under *this* name is used, and the name is deliberately
# not TEST_DATABASE_URL: that variable is what the tests themselves read, so
# exporting it for the whole gate run would make the deliberately docker-free
# unit step run the integration suite as well. A61 separated those two on
# purpose, and the separation is what keeps proving that the unit tests need no
# database. Measured: with the collision in place every integration file ran
# twice and the second pass tripped over the first one's rows.
if [ -n "${VORSCHICHT_TEST_DB_URL:-}" ]; then
  echo "with-test-db: benutze die bereitgestellte VORSCHICHT_TEST_DB_URL." >&2
  export TEST_DATABASE_URL="$VORSCHICHT_TEST_DB_URL"
  export DATABASE_URL="$TEST_DATABASE_URL"
  exec "$@"
fi

if [ -n "${TEST_DATABASE_URL:-}" ]; then
  echo "with-test-db: benutze die bereitgestellte TEST_DATABASE_URL." >&2
  # The owned path below exports both, and a caller that reads DATABASE_URL
  # must not behave differently depending on which of the two paths it took.
  export DATABASE_URL="${DATABASE_URL:-$TEST_DATABASE_URL}"
  exec "$@"
fi

IMAGE="${TEST_DB_IMAGE:-postgres:16-alpine}"
NAME="vorschicht-testdb-$$"
PORT="${TEST_DB_PORT:-0}"
PASSWORD="testdb-local-only"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if ! docker info >/dev/null 2>&1; then
  echo "with-test-db: docker nicht erreichbar." >&2
  exit 2
fi

# Port 0 lets the kernel pick a free one — no collisions with the other
# Postgres containers already running on this machine.
docker run -d --rm \
  --name "$NAME" \
  -e POSTGRES_USER=vorschicht \
  -e POSTGRES_PASSWORD="$PASSWORD" \
  -e POSTGRES_DB=vorschicht_test \
  -p "127.0.0.1:${PORT}:5432" \
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=512m \
  "$IMAGE" \
  -c fsync=off -c full_page_writes=off -c synchronous_commit=off \
  >/dev/null

MAPPED_PORT="$(docker port "$NAME" 5432/tcp | head -1 | sed 's/.*://')"
if [ -z "$MAPPED_PORT" ]; then
  echo "with-test-db: konnte den gemappten Port nicht ermitteln." >&2
  exit 2
fi

# Readiness is checked over **TCP**, and twice in a row.
#
# The postgres entrypoint starts a temporary server during initdb to create the
# database and run init scripts, then shuts it down and starts the real one.
# That temporary server answers `pg_isready` on the unix socket — so a socket
# check reports "ready", the server promptly shuts down, and the next command
# fails against a database that was ready a moment ago. It surfaced as an
# intermittent failure only once three containers ran back to back.
#
# The temporary server listens on the socket only, never on TCP. Asking over
# TCP is therefore the discriminator, and two consecutive successes cover the
# remaining instant between "listening" and "accepting".
printf 'with-test-db: warte auf Postgres auf 127.0.0.1:%s ' "$MAPPED_PORT"
ready=0
for _ in $(seq 1 120); do
  if docker exec "$NAME" pg_isready -h 127.0.0.1 -p 5432 -U vorschicht -d vorschicht_test \
       >/dev/null 2>&1; then
    ready=$((ready + 1))
    [ "$ready" -ge 2 ] && { echo "— bereit."; break; }
  else
    ready=0
    printf '.'
  fi
  sleep 0.5
done

if [ "$ready" -lt 2 ]; then
  echo >&2
  echo "with-test-db: Postgres wurde nicht rechtzeitig bereit." >&2
  docker logs "$NAME" 2>&1 | tail -20 >&2
  exit 2
fi

export TEST_DATABASE_URL="postgres://vorschicht:${PASSWORD}@127.0.0.1:${MAPPED_PORT}/vorschicht_test"
export DATABASE_URL="$TEST_DATABASE_URL"

"$@"
