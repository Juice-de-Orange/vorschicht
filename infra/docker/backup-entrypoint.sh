#!/bin/sh
# Renders the crontab from BACKUP_CRON and hands over to supercronic.
#
# The first run happens at start (once the schema is migrated, see below)
# rather than waiting until 02:30, so a fresh stack proves the backup path
# works while someone is still watching — and so the healthcheck has a
# `.last-run` to look at before its first counted probe.
set -eu

CRON_SPEC="${BACKUP_CRON:-30 2 * * *}"
CRONTAB=/tmp/vorschicht.cron

# Can this container write where everything it does ends up?
#
# `/backups` is a named volume, and an existing one keeps the ownership it was
# created with. This service ran as uid 70 until the image was corrected, so on
# every installation predating that change the volume is still `postgres`-owned
# and this container — now uid 10001 — cannot put a single file in it.
#
# Without this check that condition reports itself under the wrong name. The
# first thing to fail is `pg_dump --file=…` with EACCES, so the log and the
# result document would both say "pg_dump fehlgeschlagen" and send a reader to
# the database, while the container keeps running and stays quietly unhealthy.
# That is A58.2 one floor down, and the answer is the one `checkWritablePaths`
# already gives the daemon: refuse to start, and name the one-time repair.
#
# A real write rather than `[ -w ]`, for `writable-paths.ts`'s reason: the
# failure mode is ownership, and a directory that exists and is readable says
# nothing about whether a file may be put in it.
#
# The subshell is load-bearing and was found by running it: `:` is a POSIX
# *special* built-in, and a redirection error on one makes the shell **exit on
# the spot** — before `if` can look at the status. Written without the
# parentheses this guard printed busybox's bare `sh: can't create …` and killed
# the entrypoint, which stops the container for the right reason with the wrong
# message, and no `2>/dev/null` can suppress it because it is not the redirect
# that speaks. Inside a subshell only the subshell dies, the status reaches `!`,
# and the sentences below get to run.
if ! ( : > /backups/.write-probe ) 2>/dev/null; then
  echo "backup: /backups ist für uid $(id -u) nicht beschreibbar — kein Lauf wird" >&2
  echo 'gestartet, weil sonst pg_dump scheitert und der Fehler nach einem' >&2
  echo 'Datenbankproblem aussieht. Einmalig auf dem Host, im Stack-Verzeichnis' >&2
  echo '(mit Override-Datei zusätzlich deren -f; siehe docs/OPERATIONS.md):' >&2
  echo '  docker compose -f infra/docker-compose.yml --env-file .env \' >&2
  echo '    run --rm --user root --entrypoint chown backup -R 10001:10001 /backups' >&2
  exit 1
fi
rm -f /backups/.write-probe

printf '%s /usr/local/bin/backup-run.sh\n' "$CRON_SPEC" > "$CRONTAB"

echo "backup: Zeitplan '${CRON_SPEC}' (TZ=${TZ:-UTC})"

# How many migrations the database has recorded; empty while the table does
# not exist yet (or the database cannot be asked).
migrations_applied() {
  psql -X -q -t -A -c 'SELECT count(*) FROM _vorschicht_migrations' 2>/dev/null || true
}

# The first run must not win the race against the orchestrator's migrations.
#
# Both containers start as soon as `db` is healthy, and on a fresh installation
# this one was faster: it dumped a database with no schema in it — 822 bytes,
# zero tables — and reported `outcome=ok`, which the daemon turned into
# `backup.succeeded`. A proof of the backup path that proves an empty file.
#
# So wait until the migration table exists and its row count has stopped
# moving. Bounded, and well inside the healthcheck's patience (first counted
# probe at 60 s): a stack whose orchestrator never comes up still gets its
# first run, and the log says what that dump is worth.
wait_for_schema() {
  waited=0
  last=''
  while [ "$waited" -lt 40 ]; do
    now="$(migrations_applied)"
    if [ -n "$now" ] && [ "$now" != '0' ] && [ "$now" = "$last" ]; then
      echo "backup: Schema steht ($now Migrationen)"
      return 0
    fi
    last="$now"
    sleep 2
    waited=$((waited + 2))
  done
  echo 'backup: nach 40 s noch kein migriertes Schema — der erste Lauf sichert' >&2
  echo 'die Datenbank, wie sie ist; ein leerer Dump beweist dann nur den Pfad.' >&2
}

if [ ! -f /backups/.last-run ]; then
  wait_for_schema
  echo 'backup: erster Lauf startet sofort, damit der Pfad sofort bewiesen ist'
  /usr/local/bin/backup-run.sh || echo 'backup: erster Lauf fehlgeschlagen — siehe Log' >&2
fi

exec /usr/local/bin/supercronic -passthrough-logs "$CRONTAB"
