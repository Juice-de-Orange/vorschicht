#!/usr/bin/env bash
# Watches one phase's exit gates and pushes to ntfy when it closes — or when the
# build loop dies before it does.
#
# Silence is not success: a watch that only fires on the happy path looks
# identical to one whose build stopped an hour ago, so both outcomes push.
set -uo pipefail
REPO="${REPO:-/path/to/project}"
PHASE="${1:?Phase-Nummer angeben}"
cd "$REPO" || exit 1
set -a; . ./.env 2>/dev/null; set +a

gates() { awk -v p="Exit gates — Phase $PHASE" 'index($0,p)==1{f=1;next} f&&/^---/{exit} f' CLAUDE.md; }
push() {
  curl -sS -m 20 -o /dev/null \
    -H "Authorization: Bearer ${NTFY_TOKEN}" -H "Title: $1" -H "Priority: ${3:-default}" \
    -H "Tags: ${4:-white_check_mark}" -H "Click: https://vorschicht.example.com/" \
    -d "$2" "${NTFY_SERVER%/}/${5:-vorschicht-info}"
}

while :; do
  open=$(gates | grep -cE '^- \[ \]')
  green=$(gates | grep -cE '^- \[x\]')
  if [ "$open" -eq 0 ] && [ "$green" -gt 0 ]; then
    push "Phase $PHASE ist durch" \
         "Alle $green Exit-Gates gruen, inklusive Pruefurteil. Der Bau geht zur naechsten Phase ueber." \
         high tada vorschicht-inbox
    exit 0
  fi
  if ! pgrep -f 'bash \./vorschicht-build\.sh' >/dev/null; then
    push "Bau steht" \
         "Der Loop laeuft nicht mehr, Phase $PHASE ist noch offen ($green gruen, $open offen). Letzte Zeile: $(tail -1 .build-logs/loop.log | cut -c1-160)" \
         urgent warning vorschicht-alerts
    exit 1
  fi
  sleep 120
done
