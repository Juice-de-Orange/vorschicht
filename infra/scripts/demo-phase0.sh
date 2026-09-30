#!/usr/bin/env bash
# =============================================================================
# Phase 0 exit-gate demonstration (§22).
#
#   infra/scripts/demo-phase0.sh [--on-host]
#
# §22 requires a scripted, repeatable check per phase — "demo" explicitly does
# not mean a manual anecdote. This script is that check: it runs the actual
# assertions behind each Phase 0 gate and prints a verdict per gate.
#
# Gate states follow A38:
#   [x] green here · [~] deferred to the target host, with the command that
#   will prove it there · [ ] open
#
# Exit codes: 0 = every gate green or deferred · 1 = a gate is genuinely red.
# =============================================================================
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 2
REPO="$PWD"
COMPOSE=(docker compose -f infra/docker-compose.yml --env-file .env)
ON_HOST=0
[ "${1:-}" = '--on-host' ] && ON_HOST=1 && COMPOSE+=(-f infra/docker-compose.override.yml)

DOMAIN="${VORSCHICHT_DOMAIN:-vorschicht.example.com}"

pass=0; fail=0; deferred=0
green()    { printf '  \033[32m[x]\033[0m %s\n' "$1"; pass=$((pass+1)); }
red()      { printf '  \033[31m[ ]\033[0m %s\n' "$1"; fail=$((fail+1)); }
defer()    { printf '  \033[33m[~]\033[0m %s\n       → auf dem Produktionshost: %s\n' "$1" "$2"; deferred=$((deferred+1)); }
headline() { printf '\n\033[1m%s\033[0m\n' "$1"; }

headline 'G1 — Stack aus sauberem Checkout gesund'
unhealthy=0
for service in db app orchestrator backup; do
  cid="$("${COMPOSE[@]}" ps -q "$service" 2>/dev/null | head -1)"
  if [ -z "$cid" ]; then
    printf '       %s: kein Container\n' "$service"; unhealthy=1; continue
  fi
  health="$(docker inspect "$cid" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
  printf '       %-14s %s\n' "$service" "$health"
  [ "$health" = 'healthy' ] || [ "$health" = 'running' ] || unhealthy=1
done
[ "$unhealthy" -eq 0 ] && green 'alle Services healthy' || red 'nicht alle Services healthy'

headline 'G2 — pnpm gate grün'
if pnpm gate >/tmp/vorschicht-demo-gate.log 2>&1; then
  green 'Gate-Suite grün (typecheck, lint, tests, secrets, migrations, build)'
else
  red 'Gate-Suite rot — siehe /tmp/vorschicht-demo-gate.log'
fi

headline 'G3 — Headless claude -p (stream-json) im Container auf Abo-Auth'
cid="$("${COMPOSE[@]}" ps -q orchestrator 2>/dev/null | head -1)"
if [ -z "$cid" ]; then
  red 'Orchestrator-Container läuft nicht'
else
  auth="$(docker exec "$cid" claude auth status --json 2>/dev/null)"
  provider="$(echo "$auth" | grep -o '"apiProvider"[^,}]*' | cut -d'"' -f4)"
  method="$(echo "$auth" | grep -o '"authMethod"[^,}]*' | cut -d'"' -f4)"
  # `authMethod` used to be read, printed in the green line, and never
  # compared — so an `api_key` session would have satisfied this gate, because
  # an API key also reports `apiProvider=firstParty`. §2 forbids exactly that,
  # and the daemon does enforce it (`self-check.ts`), which is why the first
  # Betriebsprüfung of Phase 3 filed this as `process` rather than as a gate
  # that does not hold: the property was guarded, its *repeatable check* was
  # not. Kept in step with `SUBSCRIPTION_AUTH_METHODS` there.
  case " oauth_token claude.ai oauth " in
    *" $method "*) ;;
    *) red "authMethod ist '$method' — §2 erlaubt nur Abo-Anmeldung, niemals einen API-Key"
       method='' ;;
  esac
  # The gate text says "at the pinned CLI version" and nothing in this script
  # had ever looked. A27: an unpinned CLI silently replaces the runtime of the
  # model access layer.
  pinned="$(grep -E '^CLAUDE_CLI_VERSION=' "$REPO/.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')"
  running="$(docker exec "$cid" claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  if [ -z "$pinned" ]; then
    red 'CLAUDE_CLI_VERSION steht nicht in .env — der Pin nach A27 ist nicht prüfbar'
    method=''
  elif [ "$running" != "$pinned" ]; then
    red "CLI im Container ist $running, gepinnt ist $pinned (A27)"
    method=''
  fi
  if [ -z "$method" ]; then
    : # already reported above
  elif [ "$provider" != 'firstParty' ]; then
    red "apiProvider ist '$provider', erwartet 'firstParty' (§2)"
  else
    result="$(docker exec "$cid" sh -c \
      'claude -p "Antworte mit genau einem Wort: ok" --output-format stream-json --verbose --max-turns 1 2>/dev/null | tail -1')"
    if echo "$result" | grep -q '"subtype":"success"'; then
      green "Round-Trip erfolgreich (authMethod=$method, apiProvider=$provider)"
    else
      red 'Round-Trip lieferte kein erfolgreiches Result-Objekt'
    fi
  fi
fi

headline 'G3b — kein API-Key irgendwo im Stack (§2)'

image_secret_patterns() {
  # Assembled so this script does not match its own patterns.
  printf '%s\n' \
    "sk-ant-""oat[0-9A-Za-z_-]{20,}" \
    "sk-ant-""api[0-9A-Za-z_-]{20,}" \
    "\\btk_[a-z0-9]{25,}" \
    "BEGIN ""OPENSSH PRIVATE KEY"
}

leaked=0
# The tree half asserts §2's hard rule — *no API key* — so it looks for an
# Anthropic key and for nothing else. The image half asserts something different
# ("none of Vorschicht's own credentials are baked in") and keeps all four
# classes. Two gate sentences, two pattern sets; giving the tree scan the image
# scan's set made it red on a Prüfbericht that merely *names*
# `BEGIN OPENSSH PRIVATE KEY`, which is a statement about prose and not about
# the stack.
#
# A *key*, not a prefix. This searched for the bare string `sk-ant-api` until
# 2026-08-09, which matched every document naming the pattern: the Prüfbericht of
# 2026-08-02 (which quotes it while explaining how weak a bare substring grep is)
# and then the CHANGELOG entry describing this very fix. Red since A92 restored
# that report on 2026-08-03; nobody had run the script since.
#
# Sharpened rather than excluded, and that distinction is the point: an exclusion
# list blinds whole files, which is exactly A76.2's finding about `.gitleaks.toml`
# and `.env.example`, one directory over. A real credential carries twenty-odd
# key characters after the prefix; prose does not. The one thing that survives
# the shape test and is still not a credential is a placeholder that says so in
# its own text (`sk-ant-oat01-placeholder-e2e-…` in the browser suites), and it
# is skipped on that text rather than by its filename — so the file keeps being
# scanned for everything else. `.gitleaks.toml` allows the same string the same
# way, which is why `gate:secrets` is green on those files.
#
# The file set is git's, for the reason `gate-secrets.mjs` gives: an ignored
# artefact directory (`.build-logs/`, an agent worktree under `.claude/`) is not
# the repository, and a gate whose verdict depends on what happens to be lying
# around judges something other than the tree.
tree_secret_patterns() {
  printf '%s\n' \
    "sk-ant-""oat[0-9A-Za-z_-]{20,}" \
    "sk-ant-""api[0-9A-Za-z_-]{20,}"
}
while read -r hit; do
  case "$hit" in
    */demo-phase0.sh|*/.gitleaks.toml|*/config.test.ts) continue ;;
  esac
  # Every match in this file is a self-declared placeholder → not a finding.
  if ! grep -hoE "$(tree_secret_patterns | paste -sd'|')" "$hit" \
       | grep -qvi 'placeholder'; then continue; fi
  echo "       Treffer: $hit"; leaked=1
done < <(cd "$REPO" && git ls-files -co --exclude-standard -z \
           | xargs -0 grep -lIE "$(tree_secret_patterns | paste -sd'|')" 2>/dev/null \
           | sed "s#^#$REPO/#")
# The layer check used to be `docker history --no-trunc | grep 'sk-ant-'`, which
# prints the *instructions* that built each layer and never their contents — a
# credential arriving by COPY, or written by a RUN, is invisible to it. Found by
# the Betriebsprüfung of 2026-08-02 (`coverage_gap`, P0.G4), and the gate text
# claimed "zero hits in the image layers" on the strength of it.
#
# `docker export` streams the flattened filesystem as an uncompressed tar, so
# every byte of every file passes through this grep in one pass — no extraction,
# no scratch disk, no 900 MB copy. Two limits, stated rather than implied: a file
# that is itself compressed inside the image is opaque to this, and the patterns
# are *this project's* credential classes rather than gitleaks' full rule set,
# because running that over a whole container filesystem finds npm test fixtures
# and a permanently red check teaches everyone to stop reading it. What the gate
# claims is that Vorschicht's own credentials are not baked in; that is what is
# checked. Verified against a deliberately poisoned scratch image — see
# `--self-test-image-scan` below.

# One export for the clean answer, and only then one per pattern to name the
# hit. The alternation alone would say "something matched" without saying what,
# and four exports of a 900 MB image to learn "nothing matched" is three too
# many for the case that happens every time.
scan_image_filesystem() {
  local image="$1" cid hits=0 pattern
  cid="$(docker create "$image" 2>/dev/null)" || return 2
  if docker export "$cid" 2>/dev/null | grep -aqE "$(image_secret_patterns | paste -sd'|' -)"; then
    hits=1
    while IFS= read -r pattern; do
      docker export "$cid" 2>/dev/null | grep -aqE "$pattern" &&
        echo "       $image: Treffer auf Muster /$pattern/"
    done < <(image_secret_patterns)
  fi
  docker rm -f "$cid" >/dev/null 2>&1
  return "$hits"
}

scanned=0
for image in vorschicht-app vorschicht-orchestrator vorschicht-backup; do
  docker image inspect "$image" >/dev/null 2>&1 || continue
  scanned=$((scanned + 1))
  scan_image_filesystem "$image" || leaked=1
  # The image *config* carries env vars and the entrypoint, which `docker
  # export` does not include — a token passed as ENV would otherwise be missed.
  if docker image inspect "$image" --format '{{json .Config}}' 2>/dev/null \
       | grep -aqE "$(image_secret_patterns | paste -sd'|' -)"; then
    echo "       $image: Treffer in der Image-Konfiguration (ENV/ENTRYPOINT)"; leaked=1
  fi
done
if [ "$leaked" -ne 0 ]; then
  red 'API-Key-Spur gefunden'
elif [ "$scanned" -eq 0 ]; then
  defer 'kein API-Key in den Quellen; Images liegen hier nicht vor' \
        'dieselbe Prüfung dort, wo die Images gebaut sind'
else
  green "kein Zugangsdatum in den Quellen und in $scanned Image-Dateisystemen (Inhalte, nicht Bauanweisungen)"
fi

headline 'G4 — Push als Vorschicht Bot, Token nicht im Repo'
author="$(git log -1 --format='%an <%ae>' 2>/dev/null)"
if [ "$author" = 'Vorschicht Bot <vorschicht-bot@example.com>' ]; then
  if git ls-remote origin >/dev/null 2>&1; then
    local_head="$(git rev-parse HEAD)"
    remote_head="$(git rev-parse origin/main 2>/dev/null || echo none)"
    if [ "$local_head" = "$remote_head" ]; then
      green "Push erfolgt, Autor: $author"
    else
      red 'HEAD ist nicht zum Origin gepusht'
    fi
  else
    red 'Origin nicht erreichbar'
  fi
else
  red "Commit-Autor ist '$author', erwartet 'Vorschicht Bot'"
fi

# Drei Klassen, je eine Probe — des Betreibers Entscheidung vom 17.8.2026 (A133).
#
# Der alte Satz lautete „alles außer /healthz 401" und war für eine der drei
# Klassen falsch: die **statische Hülle** (`/`, das gebaute Bündel) wird nach
# §19 bewusst öffentlich ausgeliefert. Das Dashboard ist öffentlich erreichbar,
# und die Anmeldung passiert *in* der Anwendung — eine Hülle hinter 401 könnte
# gar kein Anmeldeformular zeigen. Geprüft wurde davon nur die API-Klasse, also
# stand ein Satz im Gate, den niemand widerlegen konnte, weil ihn niemand fuhr.
#
# Jetzt eine Probe je Klasse, damit ein späterer Rückbau in *jede* Richtung
# auffällt: eine Hülle, die plötzlich 401 gibt (die Anmeldung wäre unerreichbar),
# und eine API, die plötzlich 200 gibt (§19 wäre gebrochen).
#
# **Vierte Klasse, nachgetragen am 18.8.2026 auf einen `gate_invalid` der
# Betriebsprüfung 49c549b4.** Die Aufteilung vom 17.8. hatte drei Klassen und
# der Gate-Satz sagte „every API route answers 401 without a session" — das ist
# für `/api/auth/*` falsch, und zwar notwendig falsch: `PUBLIC_PREFIXES` in
# `apps/server/src/app.ts:26` nimmt genau diesen Präfix aus, weil die Anmeldung
# sonst gar nicht stattfinden könnte. `app.test.ts:227` sichert das ausdrücklich
# zu, behauptete also das Gegenteil des Hakens. Die frühere Fassung trug den
# Zusatz „non-auth" und war insoweit richtig; er ging beim Aufteilen verloren.
#
# Der Prüfer hat auch die Richtung genannt, die ohne diese Probe unsichtbar
# bliebe: nähme jemand `/api/auth/` aus der Ausnahmeliste, antwortete die
# Ceremony 401, **niemand könnte sich mehr anmelden**, und dieses Skript
# meldete unverändert grün — der Gate-Satz läse den Ausfall als Erfüllung.
headline 'G5 — HTTPS: /healthz offen, geschützte API 401, Auth-Ceremony offen, Hülle offen'
pruefe_routenklassen() {
  local basis="$1" wo="$2"
  local health guarded ceremony shell
  health="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$basis/healthz" 2>/dev/null)"
  guarded="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$basis/api/me" 2>/dev/null)"
  ceremony="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$basis/api/auth/state" 2>/dev/null)"
  shell="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$basis/" 2>/dev/null)"
  printf '       %s: /healthz → %s · /api/me → %s · /api/auth/state → %s · / (Hülle) → %s\n' \
    "$wo" "$health" "$guarded" "$ceremony" "$shell"
  [ "$health" = '200' ] && [ "$guarded" = '401' ] &&
    [ "$ceremony" = '200' ] && [ "$shell" = '200' ]
}

if [ "$ON_HOST" -eq 1 ]; then
  if pruefe_routenklassen "https://$DOMAIN" 'öffentlich'; then
    green "$DOMAIN: /healthz 200 · /api/me 401 · /api/auth/state 200 · Hülle 200 (§19: die beiden letzten absichtlich)"
  else
    red "Routenklassen falsch — erwartet 200 / 401 / 200 / 200"
  fi
else
  if pruefe_routenklassen 'http://127.0.0.1:8420' 'lokal'; then
    defer 'Routenpolitik lokal in allen vier Klassen bewiesen, TLS-Terminierung steht aus' \
          "sudo infra/scripts/install-host.sh && $0 --on-host"
  else
    red 'Routenpolitik schon lokal falsch — erwartet 200 / 401 / 200 / 200'
  fi
fi

headline 'G6 — Passkey-Bootstrap (zwei Credentials, Lock, CLI-Rescue)'
# Chrome's virtual authenticator performs the real WebAuthn ceremony against
# the real @simplewebauthn verification — the stand-in the build prompt
# (docs/build-prompt.md) sanctions. Everything asserted here is a server property, not a hardware one.
# `--project=passkey` scopes this to Phase 0's gate: the `dashboard` project in
# the same suite belongs to Phase 3 and is asserted by demo-phase3.sh.
if ./infra/scripts/with-test-db.sh pnpm exec playwright test --project=passkey \
     >/tmp/vorschicht-demo-e2e.log 2>&1; then
  green "$(grep -oE '[0-9]+ passed' /tmp/vorschicht-demo-e2e.log | tail -1) — Virtual Authenticator"
  printf '       Registrierung echter Geräte bleibt Aufgabe des Betreibers (Handy + Desktop)\n'
else
  red 'E2E rot — siehe /tmp/vorschicht-demo-e2e.log'
fi

headline 'G7 — Watchdog: Container-Kill → ntfy-Alarm ≤ 2 Intervalle'
if [ "$ON_HOST" -eq 1 ] && systemctl is-active vorschicht-watchdog.timer >/dev/null 2>&1; then
  green 'Timer aktiv — Kill-Demo: infra/scripts/demo-watchdog.sh'
else
  defer 'Watchdog-Unit und Timer sind geschrieben, aber hier nicht installiert' \
        'sudo infra/scripts/install-host.sh && infra/scripts/demo-watchdog.sh'
fi

headline 'G8 — Doku vollständig'
missing=()
for file in README.md CHANGELOG.md .env.example; do
  [ -f "$file" ] || missing+=("$file")
done
# .env.example must document every variable the config loader requires.
for key in DATABASE_URL PUBLIC_ORIGIN WEBAUTHN_RP_ID SESSION_SECRET \
           CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CLI_VERSION NTFY_SERVER NTFY_TOKEN; do
  grep -q "^${key}=" .env.example || missing+=(".env.example: $key fehlt")
done
if [ ${#missing[@]} -eq 0 ]; then
  green 'README, CHANGELOG und .env.example vollständig'
else
  printf '       fehlt: %s\n' "${missing[@]}"
  red 'Doku unvollständig'
fi

printf '\n\033[1m── Phase 0 ────────────────────────────────────\033[0m\n'
printf '  grün: %d · verschoben: %d · rot: %d\n\n' "$pass" "$deferred" "$fail"
[ "$fail" -eq 0 ] || exit 1
