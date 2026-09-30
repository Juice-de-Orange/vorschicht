#!/bin/sh
# =============================================================================
# One backup run (§18, A14).
#
#   pg_dump (custom format) + tar of the docs volume + tar of the transcripts
#   volume → /backups, then retention pruning: 14 daily, 8 weekly.
#
# Transcripts are included deliberately. §1 principle 4 makes full traceability
# a headline property; if a disk loss took the transcripts, every past decision
# would become unauditable while the database looked fine.
#
# Off-site replication to the backup host over the VPN link is a separate,
# deferred step (A35).
#
# --- Why there is a result document ------------------------------------------
#
# A partial run stays a failure. §18 wants a failed backup to be visible and
# weakening that would be the wrong repair; what was missing is somewhere to
# *say it*. Until now the only thing a run left behind for a reader was
# `.last-run`, written at the very end — so "pg_dump succeeded, the docs archive
# succeeded, and the transcript archive could not be read" and "the container
# never started" left an identical trace: nothing at all. The healthcheck read
# that nothing, and for seven days the watchdog alerted every two minutes
# without anyone being able to name a component from the outside.
#
# So every run leaves `.last-result` with the outcome **per component**, and it
# is written from an EXIT trap rather than from `fail`: `set -e` aborts on any
# unchecked command too, and a record that exists only when the failure was
# anticipated is missing in exactly the case it is worth having.
#
# Format: one `key=value` line per fact, not JSON. `sh` has no JSON writer, so a
# JSON document here would be assembled by string concatenation, where one
# unescaped character yields a document that either fails to parse or — worse —
# parses into something else, and the reader is an unattended pass that reports
# to the operator. A `key=value` line is what `printf` writes natively, a truncated write
# costs one line instead of the whole record, and the reader splits on the first
# `=`. `schema=1` comes first so that a later change of shape is a fact the
# reader can see rather than a field it silently fails to find.
#
# `.last-run` keeps its old meaning — written only by a wholly successful run,
# because that is what the container healthcheck asserts.
# =============================================================================
set -eu

BACKUP_DIR=/backups
RESULT="$BACKUP_DIR/.last-result"
KEEP_DAILY="${BACKUP_KEEP_DAILY:-14}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-8}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DOW="$(date +%u)"   # 7 = Sunday, kept as the weekly copy
STARTED_AT="$(date +%s)"

# Every component starts as `skipped`, and that is a third value rather than a
# tidier boolean: an abort leaves the components it never reached saying so,
# which is the difference between "this broke" and "this was never tried" — and
# that difference is the whole reason the document exists.
DB=skipped
DOCS=skipped
TRANSCRIPTS=skipped
PRUNE=skipped
PROBLEM=''

log() { echo "backup: $*"; }
fail() { PROBLEM="$*"; echo "backup: FEHLER — $*" >&2; exit 1; }

write_result() {
  status=$?
  if [ "$status" -eq 0 ]; then outcome=ok; else outcome=failed; fi
  # Newlines are folded to spaces before a value is written: a message that came
  # out of a tool must not be able to invent a key on the next line.
  {
    printf 'schema=1\n'
    printf 'started_at=%s\n' "$STARTED_AT"
    printf 'finished_at=%s\n' "$(date +%s)"
    printf 'stamp=%s\n' "$STAMP"
    printf 'outcome=%s\n' "$outcome"
    printf 'db=%s\n' "$DB"
    printf 'docs=%s\n' "$DOCS"
    printf 'transcripts=%s\n' "$TRANSCRIPTS"
    printf 'prune=%s\n' "$PRUNE"
    printf 'problem=%s\n' "$(printf '%s' "$PROBLEM" | tr '\n\r' '  ')"
  } > "$RESULT.tmp" && mv -f "$RESULT.tmp" "$RESULT" \
    || echo 'backup: WARNUNG — .last-result nicht schreibbar' >&2
  # Explicit, because whether a completed EXIT trap preserves the status that
  # triggered it is a detail this script must not depend on the shell for.
  exit "$status"
}
trap write_result EXIT

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

DUMP="$BACKUP_DIR/daily/db-$STAMP.dump"
log "pg_dump → $(basename "$DUMP")"
pg_dump --format=custom --compress=9 --file="$DUMP" || fail 'pg_dump fehlgeschlagen'

# A dump that cannot be listed is not a backup. Verifying the table of contents
# is cheap and catches a truncated or corrupt file on the spot rather than
# during a restore drill months later.
pg_restore --list "$DUMP" >/dev/null 2>&1 || fail 'Dump ist nicht lesbar (pg_restore --list)'
DB=ok

# One archive. Reports back instead of aborting, so the caller can record *which*
# component it was before the trap writes the document: 0 = archived,
# 2 = the volume is not mounted here, anything else = failed.
archive() {
  volume="$1"
  if [ ! -d "/data/$volume" ]; then
    log "/data/$volume fehlt — übersprungen"
    return 2
  fi
  target="$BACKUP_DIR/daily/$volume-$STAMP.tar.gz"
  log "tar /data/$volume → $(basename "$target")"
  if tar -czf "$target" -C /data "$volume"; then
    return 0
  fi
  # `tar -czf` creates its output before it reads a single input file, so a run
  # that fails part-way leaves a small, correctly-named archive containing
  # nothing — which is worse than no archive, because it is precisely the shape
  # a restore drill picks up and trusts. Seven of them, 130 bytes each, sat in
  # /backups/daily on the production host. Removed here so a failure looks like a failure.
  rm -f "$target"
  return 1
}

if archive docs; then
  DOCS=ok
else
  if [ $? -eq 2 ]; then DOCS=skipped; else DOCS=failed; fail 'tar für docs fehlgeschlagen'; fi
fi

if archive transcripts; then
  TRANSCRIPTS=ok
else
  if [ $? -eq 2 ]; then
    TRANSCRIPTS=skipped
  else
    TRANSCRIPTS=failed
    fail 'tar für transcripts fehlgeschlagen'
  fi
fi

if [ "$DOW" = '7' ]; then
  log 'Sonntag — Wochenkopie wird abgelegt'
  for file in "$BACKUP_DIR"/daily/*-"$STAMP".*; do
    [ -e "$file" ] || continue
    cp -p "$file" "$BACKUP_DIR/weekly/" || fail 'Wochenkopie fehlgeschlagen'
  done
fi

prune() {
  dir="$1"; keep="$2"; prefix="$3"
  # One "generation" is one timestamp, which produced several files. Prune by
  # distinct timestamp so a generation is never half-deleted.
  stamps="$(find "$dir" -maxdepth 1 -name "${prefix}-*" -type f 2>/dev/null \
    | sed -E "s#.*/${prefix}-([0-9]{8}-[0-9]{6})\..*#\1#" | sort -u)"
  total="$(echo "$stamps" | grep -c . || true)"
  [ "$total" -le "$keep" ] && return 0
  echo "$stamps" | head -n "$((total - keep))" | while read -r old; do
    [ -n "$old" ] || continue
    log "verwerfe Generation $old aus $(basename "$dir")"
    rm -f "$dir"/*-"$old".*
  done
}

for prefix in db docs transcripts; do
  prune "$BACKUP_DIR/daily" "$KEEP_DAILY" "$prefix" \
    || fail "Aufbewahrungsregel (daily/$prefix) fehlgeschlagen"
  prune "$BACKUP_DIR/weekly" "$KEEP_WEEKLY" "$prefix" \
    || fail "Aufbewahrungsregel (weekly/$prefix) fehlgeschlagen"
done
PRUNE=ok

date +%s > "$BACKUP_DIR/.last-run"
log "fertig ($(du -sh "$BACKUP_DIR" | cut -f1) belegt)"
