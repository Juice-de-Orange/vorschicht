#!/usr/bin/env bash
# ============================================================================
# Vorschicht bootstrap loop — unattended build via Claude Code.
#
# ############################################################################
# #  WARNING — READ BEFORE RUNNING                                           #
# #  This loop runs `claude -p` with `--dangerously-skip-permissions`: the   #
# #  session can execute any command and edit any file the user can reach.   #
# #  Run it ONLY in a sandbox (a throwaway VM or container with nothing else #
# #  on it, no personal credentials, no other repositories). It is kept as   #
# #  the record of how the studio was built; nothing in the product depends  #
# #  on it. The prompt it hands to each iteration is docs/build-prompt.md.   #
# ############################################################################
#
# Pattern: a fresh headless session per iteration; docs/STATE.md is the memory
# between them (the CLAUDE.md §0 session protocol, automated).
#
#   ./vorschicht-build.sh [repo-dir]
#   touch <repo>/STOP     # loop exits after the current iteration
#   tail -f <repo>/.build-logs/iter-*.jsonl
#
# Changes against the original draft, each for a concrete reason found while
# building Phase 0:
#
#   * **Auth is accepted from either source.** The original required
#     CLAUDE_CODE_OAUTH_TOKEN and aborted otherwise — which meant it could not
#     run on a workstation where `claude` is simply logged in. Now it takes
#     either, and verifies the *effective* state via `claude auth status`,
#     which also enforces §2's no-API-key rule rather than assuming it.
#   * **stream-json instead of text.** Text output cannot be evaluated by
#     machine, so the loop had to grep prose to guess what happened. The
#     stream's final result line carries `subtype`, `is_error` and
#     `terminal_reason` as data.
#   * **Rate limits are read, not guessed.** The stream emits
#     `rate_limit_event` with a `status` field. Grepping for phrases like
#     "usage limit" matched the model *talking about* limits as readily as
#     actually hitting one.
# ============================================================================
set -u

REPO_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
PROMPT_FILE="$REPO_DIR/docs/build-prompt.md"
LOG_DIR="$REPO_DIR/.build-logs"
MAX_ITER="${MAX_ITER:-80}"
SLEEP_ON_LIMIT="${SLEEP_ON_LIMIT:-900}"
SLEEP_ON_ERROR="${SLEEP_ON_ERROR:-60}"
MODEL="${VORSCHICHT_BUILD_MODEL:-}"

# --- preflight ---------------------------------------------------------------
die() { echo "FEHLER: $*" >&2; exit 1; }

command -v claude >/dev/null 2>&1 || die 'claude CLI nicht gefunden.'
command -v python3 >/dev/null 2>&1 || die 'python3 wird zum Auswerten der Iterationen gebraucht.'
[ "$(id -u)" -ne 0 ] || die 'nicht als root laufen lassen.'
[ -f "$REPO_DIR/CLAUDE.md" ] || die "$REPO_DIR/CLAUDE.md fehlt."
[ -f "$PROMPT_FILE" ] || die "$PROMPT_FILE fehlt."

AUTH_JSON="$(claude auth status --json 2>/dev/null)"
python3 -c "
import json, sys
try:
    s = json.loads(sys.argv[1])
except Exception:
    sys.exit('claude auth status lieferte keine auswertbare Antwort.')
if not s.get('loggedIn'):
    sys.exit('Claude Code ist nicht angemeldet — claude setup-token oder CLAUDE_CODE_OAUTH_TOKEN setzen.')
if s.get('apiProvider') != 'firstParty':
    sys.exit(f\"apiProvider ist {s.get('apiProvider')!r}, erwartet 'firstParty'. §2 verbietet API-Key-Zugang.\")
if s.get('authMethod') not in ('oauth_token', 'claude.ai', 'oauth'):
    sys.exit(f\"authMethod ist {s.get('authMethod')!r} — Vorschicht läuft ausschließlich auf Abo-Auth (§2).\")
print(f\"  Auth: {s.get('authMethod')} / {s.get('apiProvider')}\")
" "$AUTH_JSON" || exit 1

mkdir -p "$LOG_DIR"
cd "$REPO_DIR" || exit 1
echo "Vorschicht-Build startet in: $REPO_DIR  ($(date))"
echo "  CLI: $(claude --version)"
echo "Stoppen mit: touch $REPO_DIR/STOP"

# --- iteration evaluation ----------------------------------------------------
# Reads a stream-json log and prints one line: OUTCOME<TAB>DETAIL
# OUTCOME ∈ ok | rate_limited | auth_error | max_turns | error | no_result
evaluate() {
  python3 - "$1" <<'PY'
import json, sys

path = sys.argv[1]
result = None
rate_limited = False
auth_error = False
peak = {}

with open(path, encoding='utf-8', errors='replace') as handle:
    for line in handle:
        line = line.strip()
        if not line.startswith('{'):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = event.get('type')
        if kind == 'rate_limit_event':
            info = event.get('rate_limit_info') or {}
            status = info.get('status')
            # Every status the vendor prefixes with "allowed" still permits the
            # request. `allowed_warning` in particular means "past the 75%
            # warning threshold and working" — treating it as throttling made
            # the loop sleep 15 minutes after a perfectly good iteration, and
            # it fires on *every* iteration once a window is that deep. Only a
            # status that is not an allowing one is a refusal.
            if status is not None and not str(status).startswith('allowed'):
                rate_limited = True
            # A73: above the warning threshold the frame carries the real
            # figure. Surfaced so the loop's own log says how close it is,
            # instead of the operator inferring it from the sleeps.
            used = info.get('utilization')
            window = info.get('rateLimitType')
            if isinstance(used, (int, float)) and window:
                peak[window] = max(peak.get(window, 0.0), float(used))
        elif kind == 'result':
            result = event

if result is None:
    print('no_result\tkein Result-Objekt im Stream')
    sys.exit()

subtype = result.get('subtype')
reason = result.get('terminal_reason')
status = result.get('api_error_status')

budget = ''
if peak:
    budget = ' · Budget: ' + ', '.join(
        f'{w} {v * 100:.0f}%' for w, v in sorted(peak.items())
    )

if subtype == 'error_max_turns':
    print(f'max_turns\tTurn-Kappe erreicht ({reason})')
elif status in (401, 403):
    print(f'auth_error\tHTTP {status}')
elif rate_limited:
    print('rate_limited\trate_limit_event meldet Drosselung')
elif result.get('is_error'):
    print(f'error\tsubtype={subtype} reason={reason} status={status}')
else:
    text = (result.get('result') or '').strip().replace('\n', ' ')
    print(f'ok\t{text[:200]}{budget}')
PY
}

# Prints the terminal sentinel the iteration deliberately ended with, or nothing.
#
# This used to be `grep -q ALL_PHASES_DONE "$LOG"` over the whole stream-json
# transcript, and it ended the build on 2026-08-01 after five iterations. The
# iteration had done nothing wrong: its first act is to read
# `docs/build-prompt.md`, the file that *documents* the sentinel, and the
# tool result carrying that file's text landed in the transcript, where grep
# found it. Every iteration that reads its own instructions would have ended the
# loop the same way.
#
# So only the final `result` message counts, only its last non-empty line, and
# that line must *be* the sentinel rather than contain it — the agent's own last
# word, not evidence it happened to quote. Markdown decoration is stripped
# because a model asked for a bare word will still sometimes wrap it in
# backticks or bold.
sentinel() {
  python3 - "$1" <<'PY'
import json, re, sys

result = None
with open(sys.argv[1], encoding='utf-8', errors='replace') as handle:
    for line in handle:
        line = line.strip()
        if not line.startswith('{'):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get('type') == 'result':
            result = event

if result is None:
    sys.exit()

lines = [l.strip() for l in (result.get('result') or '').splitlines() if l.strip()]
if not lines:
    sys.exit()

last = re.sub(r'^[`*_#>\s-]+|[`*_\s.]+$', '', lines[-1])
if last in ('ALL_PHASES_DONE', 'BUILD_BLOCKED_WAITING_FOR_OPERATOR'):
    print(last)
PY
}

# --- loop --------------------------------------------------------------------
i=0
while :; do
  if [ -f "$REPO_DIR/STOP" ]; then
    echo "STOP-Datei gefunden — Loop beendet sich sauber. ($(date))"
    break
  fi
  i=$((i + 1))
  if [ "$i" -gt "$MAX_ITER" ]; then
    echo "the operator. Iterationen ($MAX_ITER) erreicht — Loop endet. ($(date))"
    break
  fi

  TS="$(date +%Y%m%d-%H%M%S)"
  LOG="$LOG_DIR/iter-$(printf '%03d' "$i")-$TS.jsonl"
  echo "=== Iteration $i — $(date) ==="

  ARGS=(-p "$(cat "$PROMPT_FILE")"
        --dangerously-skip-permissions
        --output-format stream-json --verbose)
  [ -n "$MODEL" ] && ARGS+=(--model "$MODEL")

  claude "${ARGS[@]}" >"$LOG" 2>&1
  RC=$?

  VERDICT="$(evaluate "$LOG")"
  OUTCOME="${VERDICT%%	*}"
  DETAIL="${VERDICT#*	}"
  echo "--- Iteration $i: $OUTCOME (exit $RC) — $DETAIL"

  # Tell the dashboard where the build stands. Never fatal: a status update that
  # could not be delivered must not stop the build.
  node "$REPO_DIR/infra/scripts/report-build.mjs" 2>&1 | tail -1 || true

  # Terminal sentinels — the iteration's own last word, never a string found
  # somewhere in its transcript. See `sentinel()` for why that distinction
  # ended a build today.
  case "$(sentinel "$LOG")" in
    ALL_PHASES_DONE)
      # The claim is checked against the evidence before it is believed. An
      # unticked gate in CLAUDE.md contradicts "every phase is done", and a
      # completion report that the repository disagrees with is a finding, not
      # a reason to stop building.
      OPEN=$(grep -cE '^- \[ \]' "$REPO_DIR/CLAUDE.md" || true)
      if [ "${OPEN:-0}" -gt 0 ]; then
        echo "ALL_PHASES_DONE gemeldet, aber $OPEN Gates sind in CLAUDE.md offen — Meldung verworfen, Bau läuft weiter."
      else
        echo "ALL_PHASES_DONE gemeldet und in CLAUDE.md bestätigt — Bau abgeschlossen. ($(date))"
        break
      fi
      ;;
    BUILD_BLOCKED_WAITING_FOR_OPERATOR)
      echo "Blockiert auf den Betreiber (docs/STATE.md → WAITING FOR OPERATOR). Loop endet sauber. ($(date))"
      break
      ;;
  esac

  case "$OUTCOME" in
    auth_error)
      echo "AUTH-FEHLER — Loop stoppt. Token prüfen (claude setup-token) und neu starten."
      break
      ;;
    rate_limited)
      echo "Abo-Limit erreicht — schlafe $((SLEEP_ON_LIMIT / 60)) min."
      sleep "$SLEEP_ON_LIMIT"
      continue
      ;;
    error | no_result)
      echo "Iteration unsauber beendet — weiter in ${SLEEP_ON_ERROR}s."
      sleep "$SLEEP_ON_ERROR"
      ;;
    *)
      [ "$RC" -ne 0 ] && { echo "Exit-Code $RC — weiter in ${SLEEP_ON_ERROR}s."; sleep "$SLEEP_ON_ERROR"; }
      ;;
  esac

  sleep 5
done

echo "Loop beendet nach $i Iteration(en). Logs: $LOG_DIR  ($(date))"
