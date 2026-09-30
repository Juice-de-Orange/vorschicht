# ADR 0006 — The dashboard is publicly reachable behind the host's nginx, and push goes through ntfy

- **Status:** accepted
- **Date:** 2026-07-31
- **Context:** §2 (Ingress, Push), §17 (PWA), §18.1, §19
- **Condenses:** A1

## Decision

- Dashboard host: `vorschicht.example.com`, an ordinary public DNS record, **not** proxied
  through a CDN.
- The Hono `app` service binds to `127.0.0.1:8420` only. The host's existing nginx is the
  sole public web entry; it terminates TLS with the host's certbot like every other vhost on
  that machine.
- No Web Push API in v1. Push notifications go through the self-hosted ntfy instance
  (`ntfy.example.com`), which is also routed through the host nginx.
- Public exposure was explicitly confirmed by the operator on 2026-07-31; a VPN-only
  dashboard was considered and rejected.

## Why

The dashboard is meant to be opened on a phone, anywhere, with zero clicks to "is everything
fine" (§17.1). A VPN-only variant would have made every inbox answer depend on a tunnel being
up, which is exactly the friction §15's "studio owner" model tries to remove. The compensating
controls are the ones §19 already required: passkeys (WebAuthn) as the only login, rate
limiting on the auth endpoints, HttpOnly/Secure/SameSite=Strict cookies, and an audit log of
every dashboard action. Binding the app to loopback means a misconfigured firewall still
exposes nothing but nginx.

ntfy was chosen over Web Push because it already ran on the host, needs no VAPID key
management, and delivers to a phone app without a service-worker push subscription. One push
channel is one failure mode.

Rejected alternatives, for the record: a VPN-only dashboard (friction on every decision), CDN
proxying (a third party in front of a passkey ceremony, for no gain on a single-user site),
and running the app on a public interface with its own TLS (a second certificate regime on a
host that already has one).

## Consequences

- §19's controls are load-bearing rather than defence in depth. The sign-in happens *inside*
  the app, so the static shell and the auth ceremony under `/api/auth/` are deliberately
  public while every other API route answers 401. P0.G5 states this as four route classes and
  `infra/scripts/demo-phase0.sh` probes one route per class in both directions (A133, A141) —
  a ceremony that started answering 401 would otherwise read as "more secure" while nobody
  could log in.
- Accepted limitation, recorded in §18.1 and ADR 0012: because ntfy is behind the same nginx,
  a full outage of the production host also silences push. There is no second alert path.
- The mechanics changed once without the decision changing: on the first production host, port
  443 turned out to be owned by another proxy (an nginx `stream` block doing SNI passthrough, A40).
  Vorschicht then terminated TLS on a private loopback port behind that router with
  `proxy_protocol`, so the client address survived the extra hop for the rate limiter and the
  audit log. The public template (`infra/nginx/vorschicht.conf`) listens on 443 directly; a host
  with such a router needs an adapted listen line, and the lesson from that host stands: the
  collision does not surface in `nginx -t`, only as a reload that fails to bind while systemd
  reports success — `install-host.sh` therefore checks the journal after every reload.
- Every hostname, IP and path in this repository's examples is a placeholder; the real values
  live only in the host's `.env` and nginx configuration.

## Evidence

- `infra/nginx/` — the vhost snippet; `infra/scripts/install-host.sh` — host installation
  including the SNI map entry and the bind check.
- `apps/server/src/app.ts` — `PUBLIC_PREFIXES` names the one public API prefix;
  `apps/server/src/app.test.ts` asserts the four route classes.
- P0.G5's evidence line in `CLAUDE.md` §22 records the public-internet verification.
