#!/usr/bin/env bash
# =============================================================================
# Host installation for the production host (§22 Phase 0, steps 7 and 9).
#
#   sudo VORSCHICHT_ACME_EMAIL=you@example.com infra/scripts/install-host.sh [--skip-tls] [--skip-watchdog]
#
# VORSCHICHT_ACME_EMAIL (the Let's Encrypt contact address) has no default and is
# required unless --skip-tls is given; VORSCHICHT_DOMAIN defaults to
# vorschicht.example.com and must be set to the real hostname.
#
# Idempotent by construction: every step checks its own end state first, so
# re-running after a partial failure is safe and is in fact the intended
# recovery path.
#
# What it does NOT do: touch any other vhost, service or stack on the host.
# The production host is a shared host carrying other stacks; this script only
# ever adds files whose names begin with `vorschicht`.
# =============================================================================
set -euo pipefail

DOMAIN="${VORSCHICHT_DOMAIN:-vorschicht.example.com}"
# No default: the ACME contact address is the operator's, and Let's Encrypt
# sends expiry notices there. The script refuses to run without it.
EMAIL="${VORSCHICHT_ACME_EMAIL:-}"
DATA_ROOT="${VORSCHICHT_DATA_ROOT:-/srv/vorschicht}"
STACK_DIR="${VORSCHICHT_STACK_DIR:-/opt/vorschicht}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WEBROOT=/var/www/certbot

SKIP_TLS=0
SKIP_WATCHDOG=0
for arg in "$@"; do
  case "$arg" in
    --skip-tls) SKIP_TLS=1 ;;
    --skip-watchdog) SKIP_WATCHDOG=1 ;;
    *) echo "Unbekanntes Argument: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
ok()   { printf '  ✓ %s\n' "$1"; }
skip() { printf '  · %s\n' "$1"; }
die()  { printf '  ✗ %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die 'Bitte mit sudo ausführen.'

# --- 1. data directories -----------------------------------------------------
step "Datenverzeichnisse unter $DATA_ROOT"
for dir in postgres docs transcripts worktrees backups claude; do
  if [ -d "$DATA_ROOT/$dir" ]; then
    skip "$DATA_ROOT/$dir existiert"
  else
    mkdir -p "$DATA_ROOT/$dir"
    ok "$DATA_ROOT/$dir angelegt"
  fi
done
# Ownership follows the uid each container actually runs as — read off the
# Dockerfiles, not remembered:
#   10001 — app, orchestrator **and backup** (`USER 10001:10001` in all three).
#           The backup image is based on postgres:alpine but no longer runs as
#           its `postgres` user (uid 70): it could not read the transcripts it
#           archives (Dockerfile.backup). This script still handed `backups/` to
#           uid 70, and the sidecar's entrypoint refuses a /backups it cannot
#           write — so a fresh host install stopped at its first backup.
#      70 — only `db`, the stock postgres image. Its entrypoint starts as root
#           and takes over its own data directory, so `postgres/` is left as it
#           is here.
chown -R 10001:10001 "$DATA_ROOT/claude" "$DATA_ROOT/transcripts" "$DATA_ROOT/docs" \
  "$DATA_ROOT/worktrees" "$DATA_ROOT/backups" 2>/dev/null || true
chmod 750 "$DATA_ROOT"

# --- 2. TLS ------------------------------------------------------------------
if [ "$SKIP_TLS" -eq 1 ]; then
  step 'TLS übersprungen (--skip-tls)'
else
  step 'TLS und nginx-Vhost'

  [ -n "$EMAIL" ] || die 'VORSCHICHT_ACME_EMAIL ist nicht gesetzt — die ACME-Kontaktadresse hat keine Voreinstellung.'

  command -v nginx >/dev/null || die 'nginx ist nicht installiert.'

  if ! command -v certbot >/dev/null; then
    echo '  certbot wird installiert…'
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot >/dev/null
    ok 'certbot installiert'
  else
    skip 'certbot vorhanden'
  fi

  mkdir -p "$WEBROOT/.well-known/acme-challenge"

  # The A record must exist and point here, or the ACME challenge cannot
  # succeed. Checking first turns a confusing certbot failure into a clear one.
  resolved="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
  [ -n "$resolved" ] || die "$DOMAIN löst nicht auf — A-Record fehlt."
  ok "$DOMAIN → $resolved"

  CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
  if [ -f "$CERT_DIR/fullchain.pem" ]; then
    skip 'Zertifikat vorhanden'
  else
    echo '  Stage-1-Vhost (nur HTTP) für die ACME-Challenge…'
    install -m 0644 "$REPO_DIR/infra/nginx/vorschicht-bootstrap.conf" \
      /etc/nginx/sites-available/vorschicht
    ln -sfn /etc/nginx/sites-available/vorschicht /etc/nginx/sites-enabled/vorschicht
    nginx -t >/dev/null || die 'nginx-Konfiguration ungültig (Stage 1)'
    systemctl reload nginx
    ok 'Stage-1-Vhost aktiv'

    certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" \
      --non-interactive --agree-tos -m "$EMAIL" --no-eff-email \
      || die 'certbot ist gescheitert — siehe /var/log/letsencrypt/letsencrypt.log'
    ok 'Zertifikat ausgestellt'
  fi

  install -m 0644 "$REPO_DIR/infra/nginx/vorschicht.conf" /etc/nginx/sites-available/vorschicht
  ln -sfn /etc/nginx/sites-available/vorschicht /etc/nginx/sites-enabled/vorschicht

  # The vhost listens on 443 directly. On a host whose port 443 is already owned
  # by another proxy (for example an nginx `stream` block doing SNI passthrough),
  # adapt the `listen` line in infra/nginx/vorschicht.conf before installing:
  # http and stream cannot share a port, and the collision does not surface in
  # `nginx -t` — it surfaces as a *reload* that fails to bind and leaves the old
  # config running while systemd reports success. Hence the check below.
  nginx -t >/dev/null || die 'nginx-Konfiguration ungültig (Stage 2)'
  systemctl reload nginx
  sleep 1
  # `systemctl reload` only signals; a failed bind leaves the old config live
  # and still reports success. Check that the reload actually took.
  if journalctl -u nginx --since '30 seconds ago' --no-pager 2>/dev/null | grep -q 'could not bind'; then
    die 'nginx konnte nach dem Reload nicht binden — alte Konfiguration läuft weiter.'
  fi
  ok 'TLS-Vhost aktiv (443)'

  # certbot's own timer handles renewal; it just needs nginx to pick up the new
  # certificate afterwards.
  mkdir -p /etc/letsencrypt/renewal-hooks/deploy
  cat > /etc/letsencrypt/renewal-hooks/deploy/vorschicht-reload-nginx.sh <<'HOOK'
#!/bin/sh
# Installed by Vorschicht: reload nginx after a certificate renewal.
systemctl reload nginx
HOOK
  chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/vorschicht-reload-nginx.sh
  ok 'Renewal-Hook installiert'
fi

# --- 3. watchdog -------------------------------------------------------------
if [ "$SKIP_WATCHDOG" -eq 1 ]; then
  step 'Watchdog übersprungen (--skip-watchdog)'
else
  step 'Watchdog (systemd-Timer, alle 2 Minuten)'
  install -m 0644 "$REPO_DIR/infra/systemd/vorschicht-watchdog.service" \
    /etc/systemd/system/vorschicht-watchdog.service
  install -m 0644 "$REPO_DIR/infra/systemd/vorschicht-watchdog.timer" \
    /etc/systemd/system/vorschicht-watchdog.timer
  # The unit hard-codes /opt/vorschicht; if the stack lives elsewhere, override
  # rather than editing the checked-in unit.
  if [ "$STACK_DIR" != '/opt/vorschicht' ]; then
    mkdir -p /etc/systemd/system/vorschicht-watchdog.service.d
    cat > /etc/systemd/system/vorschicht-watchdog.service.d/override.conf <<EOF
[Service]
Environment=VORSCHICHT_STACK_DIR=$STACK_DIR
ExecStart=
ExecStart=$STACK_DIR/infra/scripts/watchdog.sh
EOF
    ok "Override auf $STACK_DIR geschrieben"
  fi
  mkdir -p /var/lib/vorschicht
  systemctl daemon-reload
  systemctl enable --now vorschicht-watchdog.timer >/dev/null
  ok "Timer aktiv: $(systemctl is-active vorschicht-watchdog.timer)"
fi

step 'Fertig'
echo "  Vhost:    https://$DOMAIN"
echo "  Daten:    $DATA_ROOT"
echo "  Watchdog: systemctl status vorschicht-watchdog.timer"
