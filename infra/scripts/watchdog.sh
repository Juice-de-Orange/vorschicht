#!/usr/bin/env bash
# =============================================================================
# Host watchdog (§18.1, A23).
#
# Runs from a systemd timer every 2 minutes, outside the compose stack — a
# watchdog living inside the thing it watches is decoration.
#
# Checks two independent things:
#   1. Container health states reported by Docker.
#   2. The orchestrator's own heartbeat file, which it stops touching when it
#      is wedged mid-loop. A container can be "running" and "healthy" by
#      Docker's reckoning while the daemon inside has stopped doing anything.
#
# On the first consecutive failure it alerts and makes exactly ONE start
# attempt. After that it alerts only. A watchdog that keeps restarting a
# service which keeps dying produces a pager storm and hides the real cause —
# A23 says one attempt, and this is where that is enforced.
#
# ALERT THROTTLING (A67.6, A86.5). A23's "repeated failure → alert only" was
# read as a rule about restarts and built as one; the alert itself stayed
# ungoverned. Measured on the production host: a `backup` container unhealthy for seven
# days produced 5525 journal lines and 2026 delivered ntfy alerts — roughly 290
# pushes a day for one fault. A channel that pushes every two minutes is a
# channel that gets muted, and then the next real alert is invisible; that is
# A67.6's sentence about the Ops alert and A86.5's about the notifications
# pass, and it applies here word for word. So: one alert on entry, one on
# recovery, and at most one reminder every six hours in between. Recovery is
# the half that did not exist at all — without it a quiet channel and a fixed
# stack look identical from the phone.
#
# The state file carries three fields for three different questions:
#   phase        ok | failing — governs A23's single restart attempt
#   since        when the outage started, for the reminder's own text
#   announced_at when an alert last *reached* ntfy, which is what throttles
# `phase` and `announced_at` are deliberately separate. Tying the restart
# attempt to delivery would repeat the restart every two minutes for as long as
# ntfy was unreachable, which is precisely the loop A23 forbids; tying the
# throttle to the phase would record an alert nobody received as sent, which is
# precisely what A86.5 forbids. One field cannot hold both rules.
#
# Consciously accepted blind spot (§18.1): if the production host itself is down, nothing
# here runs and no alert is sent. Documented, not mitigated.
#
# Second accepted cost, stated rather than discovered later: a service whose
# health check flaps produces an entry alert and a recovery alert per flap, so
# a stack that oscillates every two minutes is noisier than it was before this
# change (two pushes per flap instead of one). The fault this was built for is
# the permanent one, hysteresis is machinery the brief did not ask for, and a
# watchdog that says nothing about a flapping stack would be wrong in the other
# direction. Named here so the next reader weighs it rather than rediscovers it.
# =============================================================================
set -uo pipefail

STACK_DIR="${VORSCHICHT_STACK_DIR:-/opt/vorschicht}"
COMPOSE_FILES=(-f "$STACK_DIR/infra/docker-compose.yml" -f "$STACK_DIR/infra/docker-compose.override.yml")
ENV_FILE="${VORSCHICHT_ENV_FILE:-$STACK_DIR/.env}"
STATE_FILE="${VORSCHICHT_WATCHDOG_STATE:-/var/lib/vorschicht/watchdog.state}"
HEARTBEAT_MAX_AGE=180     # seconds; the daemon writes every 30s
REMINDER_SECONDS=21600    # 6h between reminders while the fault persists

mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true

# --- notification ------------------------------------------------------------
# Credentials come from the stack's .env; the watchdog never carries its own.
NTFY_SERVER=''; NTFY_TOKEN=''
# The topic is configurable, and hard-coding it here sent every outage alert to
# `vorschicht-alerts` even when the operator had pointed the stack somewhere
# else — i.e. to a topic nobody was subscribed to, for exactly the events that
# matter most. Found by the Betriebsprüfung; the daemon had the same defect one
# directory over (A86) and it is the same fix.
NTFY_TOPIC_ALERTS='vorschicht-alerts'
if [ -r "$ENV_FILE" ]; then
  NTFY_SERVER="$(grep -E '^NTFY_SERVER=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  NTFY_TOKEN="$(grep -E '^NTFY_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  configured_topic="$(grep -E '^NTFY_TOPIC_ALERTS=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  [ -n "$configured_topic" ] && NTFY_TOPIC_ALERTS="$configured_topic"
fi

# The syslog line says *what happened*; the second one says whether the push
# actually went out. They used to be one line, written before the ntfy block and
# independently of it — so P0.G7's scripted proof ("kill → ntfy alert") was green
# on a host where ntfy was unconfigured (the `if` is skipped) or unreachable (the
# `||` swallowed it). Found by the Betriebsprüfung, which un-ticked the gate.
#
# Returns: 0 delivered · 1 attempted and refused · 2 no channel configured.
# The caller must treat 1 and 2 differently: retrying a channel that does not
# exist is not resilience, it is the same loop under another name.
alert() {
  local title="$1" body="$2" priority="${3:-high}"
  logger -t vorschicht-watchdog "$title: $body"
  echo "$(date -Is) $title: $body"
  if [ -z "$NTFY_SERVER" ] || [ -z "$NTFY_TOKEN" ]; then
    logger -t vorschicht-watchdog 'ntfy: nicht konfiguriert — kein Push versucht'
    return 2
  fi
  if curl -sS -m 10 -o /dev/null -f \
      -H "Authorization: Bearer $NTFY_TOKEN" \
      -H "Title: $title" \
      -H "Priority: $priority" \
      -H "Tags: rotating_light" \
      -d "$body" \
      "${NTFY_SERVER%/}/${NTFY_TOPIC_ALERTS}"; then
    logger -t vorschicht-watchdog "ntfy: Alarm an ${NTFY_TOPIC_ALERTS} zugestellt"
    return 0
  fi
  logger -t vorschicht-watchdog "ntfy: Alarm an ${NTFY_TOPIC_ALERTS} NICHT zugestellt"
  echo 'watchdog: ntfy nicht erreichbar' >&2
  return 1
}

compose() { docker compose "${COMPOSE_FILES[@]}" --env-file "$ENV_FILE" "$@"; }

# --- state -------------------------------------------------------------------
# Every run is a fresh process started by the timer, so everything the throttle
# knows has to survive in this file. It lives beside the audit log under the
# unit's own StateDirectory (`/var/lib/vorschicht`, root-owned, created and
# declared by the systemd unit) rather than in /tmp: a state that a reboot or a
# tmpfiles sweep resets would announce the same outage again on the next run,
# which is the noise this exists to remove.
#
# The parse is deliberately tolerant of a bare `ok` / `failing`, because that is
# what a human — and demo-watchdog.sh's restore step — writes by hand.
PHASE='ok'; SINCE=0; ANNOUNCED_AT=0
if [ -r "$STATE_FILE" ]; then
  stored_phase=''; stored_since=''; stored_announced=''
  read -r stored_phase stored_since stored_announced < "$STATE_FILE" || true
  [ "$stored_phase" = 'failing' ] && PHASE='failing'
  case "$stored_since" in     ''|*[!0-9]*) SINCE=0;;        *) SINCE="$stored_since";; esac
  case "$stored_announced" in ''|*[!0-9]*) ANNOUNCED_AT=0;; *) ANNOUNCED_AT="$stored_announced";; esac
fi

save_state() {
  if [ "$PHASE" = 'ok' ]; then
    printf 'ok\n' > "$STATE_FILE"
  else
    printf 'failing %s %s\n' "$SINCE" "$ANNOUNCED_AT" > "$STATE_FILE"
  fi
}

# A86.5, word for word: the state flips only on a delivered alert. An ntfy that
# went down with the stack has to be tried again rather than recorded as having
# reported. `2` (no channel configured) counts as settled — there is nothing to
# retry, and the alternative is a "nicht konfiguriert" line every two minutes
# forever on a host that simply has no push channel.
announce() {
  local title="$1" body="$2" priority="$3" sent
  alert "$title" "$body" "$priority"; sent=$?
  if [ "$sent" -ne 1 ]; then
    ANNOUNCED_AT="$(date +%s)"
    save_state
  fi
  return 0
}

dauer_text() {
  local s="$1"
  if   [ "$s" -lt 3600 ];   then printf '%d Minuten' $(( s / 60 ))
  elif [ "$s" -lt 172800 ]; then printf '%d Stunden' $(( s / 3600 ))
  else                           printf '%d Tage'    $(( s / 86400 ))
  fi
}

# --- checks ------------------------------------------------------------------
problems=()
DOCKER_OK=1

# An unreachable Docker daemon used to alert and exit before the state file was
# ever consulted — the same unthrottled push every two minutes, in the same
# file, for the same class of fault. It is a problem like any other now; what it
# additionally suppresses is the restart attempt, which cannot work without the
# daemon and would otherwise be written into the audit log as though it had.
if ! docker info >/dev/null 2>&1; then
  DOCKER_OK=0
  problems+=('Docker nicht erreichbar — die Container konnten nicht geprüft werden')
fi

if [ "$DOCKER_OK" -eq 1 ]; then
  for service in db app orchestrator backup; do
    cid="$(compose ps -q "$service" 2>/dev/null | head -1)"
    if [ -z "$cid" ]; then
      problems+=("$service: kein Container vorhanden")
      continue
    fi
    state="$(docker inspect "$cid" --format '{{.State.Status}}' 2>/dev/null)"
    health="$(docker inspect "$cid" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null)"
    if [ "$state" != 'running' ]; then
      problems+=("$service: Status $state")
    elif [ "$health" = 'unhealthy' ]; then
      problems+=("$service: unhealthy")
    fi
  done

  # The heartbeat catches a daemon that is up but no longer doing anything.
  orchestrator_cid="$(compose ps -q orchestrator 2>/dev/null | head -1)"
  if [ -n "$orchestrator_cid" ]; then
    beat="$(docker exec "$orchestrator_cid" cat /tmp/vorschicht-heartbeat 2>/dev/null | tr -d '[:space:]')"
    if [ -z "$beat" ]; then
      problems+=('orchestrator: kein Heartbeat')
    else
      age=$(( ($(date +%s) - beat / 1000) ))
      if [ "$age" -gt "$HEARTBEAT_MAX_AGE" ]; then
        problems+=("orchestrator: Heartbeat ${age}s alt (max ${HEARTBEAT_MAX_AGE}s)")
      fi
    fi
  fi
fi

# --- verdict -----------------------------------------------------------------
now="$(date +%s)"

if [ ${#problems[@]} -eq 0 ]; then
  if [ "$PHASE" = 'ok' ]; then
    save_state
    exit 0
  fi
  # Recovery — the half of the transition that did not exist. Without it "quiet"
  # and "fixed" are the same signal, and the throttle above would have turned a
  # loud channel into an unreadable one.
  if [ "$SINCE" -gt 0 ]; then
    dauer="Die Störung dauerte $(dauer_text $(( now - SINCE )))."
  else
    dauer='Beginn der Störung unbekannt.'
  fi
  alert 'Vorschicht: Stack wieder gesund' "Alle Dienste melden sich wieder gesund.
$dauer" default
  if [ $? -eq 1 ]; then
    # Not delivered. The phase stays `failing` so the next run says it again.
    # Cost, deliberately taken: an outage returning within the next two minutes
    # is treated as ongoing and gets no second restart attempt — the quiet
    # direction, and the one A23 already prefers.
    exit 1
  fi
  PHASE='ok'
  save_state
  exit 0
fi

summary="$(printf '• %s\n' "${problems[@]}")"

if [ "$PHASE" = 'ok' ]; then
  # Entry. The phase flips here regardless of delivery, so A23's single restart
  # attempt stays single even when nobody can be told about it.
  PHASE='failing'; SINCE="$now"; ANNOUNCED_AT=0
  save_state

  if [ "$DOCKER_OK" -eq 1 ]; then
    # Audit trail lives with the stack, since the event log may be exactly what
    # is unreachable right now.
    echo "$(date -Is) watchdog: single restart attempt after: ${problems[*]}" \
      >> "$(dirname "$STATE_FILE")/watchdog.audit.log"
    compose start >/dev/null 2>&1 || true
    massnahme='Ein einmaliger Startversuch läuft.'
    prioritaet='high'
  else
    massnahme='Kein Startversuch — der Docker-Daemon ist nicht erreichbar.'
    prioritaet='urgent'
  fi

  announce 'Vorschicht: Stack ungesund' "$summary
$massnahme" "$prioritaet"
  exit 1
fi

if [ "$ANNOUNCED_AT" -eq 0 ]; then
  # The entry alert never reached anybody. Say it again — this is the retry
  # A86.5 asks for, and it is why delivery has its own field.
  announce 'Vorschicht: Stack ungesund' "$summary
Der einmalige Startversuch (A23) ist bereits gelaufen; ein weiterer erfolgt nicht." urgent
  exit 1
fi

if [ $(( now - ANNOUNCED_AT )) -ge "$REMINDER_SECONDS" ]; then
  if [ "$SINCE" -gt 0 ]; then
    dauer="Ungesund seit $(dauer_text $(( now - SINCE )))."
  else
    dauer='Beginn der Störung unbekannt.'
  fi
  announce 'Vorschicht: Stack weiterhin ungesund' "$summary
$dauer Kein weiterer Startversuch (A23) — bitte manuell nachsehen.
Nächste Erinnerung frühestens in 6 Stunden." urgent
  exit 1
fi

# Throttled. Deliberately no `logger` line: the syslog tag `vorschicht-watchdog`
# is the alert trail P0.G7's proof reads, and a line there every two minutes for
# a week is the same defect one layer down (5525 of them were measured). stdout
# is captured by systemd under the unit, so a run is still traceable via
# `journalctl -u vorschicht-watchdog.service` without touching that trail.
echo "$(date -Is) Stack weiterhin ungesund; Alarm gedrosselt, nächste Erinnerung in $(dauer_text $(( REMINDER_SECONDS - (now - ANNOUNCED_AT) )))"
exit 1
