#!/bin/sh
# Renders the crontab from BACKUP_CRON and hands over to supercronic.
#
# The first run happens immediately rather than waiting until 02:30, so a fresh
# stack proves the backup path works while someone is still watching — and so
# the healthcheck has a `.last-run` to look at within its start period.
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
  echo 'Datenbankproblem aussieht. Einmalig auf dem Host (siehe docs/OPERATIONS.md):' >&2
  echo '  docker compose run --rm --user root --entrypoint chown backup \' >&2
  echo '    -R 10001:10001 /backups' >&2
  exit 1
fi
rm -f /backups/.write-probe

printf '%s /usr/local/bin/backup-run.sh\n' "$CRON_SPEC" > "$CRONTAB"

echo "backup: Zeitplan '${CRON_SPEC}' (TZ=${TZ:-UTC})"

if [ ! -f /backups/.last-run ]; then
  echo 'backup: erster Lauf startet sofort, damit der Pfad sofort bewiesen ist'
  /usr/local/bin/backup-run.sh || echo 'backup: erster Lauf fehlgeschlagen — siehe Log' >&2
fi

exec /usr/local/bin/supercronic -passthrough-logs "$CRONTAB"
