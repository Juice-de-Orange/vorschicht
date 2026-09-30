# =============================================================================
# app — Hono API + SSE + static PWA assets (§3).
#
# Base images are pinned by digest, not by tag. The production host runs watchtower across
# every container nightly at 04:00 with rolling restarts (A34); a floating tag
# would let it swap the runtime under an autonomous system while nobody is
# watching. Updates arrive as radar tasks through the gates, like any other
# dependency (A27).
# =============================================================================
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46

# --- build -------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /build

# CI=true makes pnpm non-interactive: without it `pnpm deploy` asks before
# rebuilding the modules directory and aborts outright when there is no TTY.
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

# Manifests first so a source-only change does not re-resolve the dependency
# graph on every build.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/mcp/package.json packages/mcp/
COPY apps/server/package.json apps/server/
COPY apps/orchestrator/package.json apps/orchestrator/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm -r --if-present build \
 && pnpm deploy --filter @vorschicht/server --prod --legacy /out/server \
 && cp -r apps/web/dist /out/web

# --- runtime -----------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

# The upstream poppler version bookworm ships. Not the Debian revision.
#
# `22.12.0-2+deb12u2` is what bookworm/main carries and `-2+deb12u3` is what
# bookworm-security already carries (both measured in the pinned base). Pinning
# the revision would therefore **break the build** the next time a security fix
# supersedes one and the archive drops it — the opposite of what a pin is for.
# The upstream number is stable across those revisions, so asserting it accepts
# every security update and still fails loudly if the base digest ever moves to
# a different Debian release (trixie ships 24.x).
ARG POPPLER_VERSION=22.12.0

# =============================================================================
# poppler-utils — §13's PDF text extraction, in a subprocess.
#
# This is the first `apt-get` in this image, so it sets the precedent: the base
# stays digest-pinned (A34) and everything installed on top is named, asserted
# and nothing else. `--no-install-recommends` matters here rather than being a
# habit — the recommends of poppler-utils pull in a graphics stack this image
# has no use for.
#
# **The cost, measured — and the instrument named with it**, because docker 29
# with the containerd store answers this question three different ways for the
# same image and a bare number would be unreproducible (§8.2 domain 8). Both
# sides built from this working tree in one run, identical source, poppler the
# only difference:
#
#   du -sxm / (inside, uncompressed on disk)   284 → 309 MiB     +25 MiB
#   docker image ls                            387 → 427 MB      +40 MB
#   docker image inspect .Size (compressed)  86.6 → 97.5 MB      +10.9 MB
#
# The first is the one to compare against gitleaks' "23 MB in the image" in
# Dockerfile.orchestrator: same order, same trade, and the same conclusion.
#
# **Why a subprocess and not a library.** A PDF parser processes untrusted input
# by definition, and the known failure class for the JavaScript one is arbitrary
# code execution (CVE-2024-4367; CVE-2026-16633, published 2026-08-06 and fixed
# only in pdf.js 6.2.108). In-process a hit lands in the Node process that holds
# `SESSION_SECRET`, `DATABASE_URL`, `NTFY_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN`;
# in a subprocess started with a minimal environment (`pdftotextEnv`) it lands
# in a child holding none of them. Poppler's class is denial of service, which
# the extractor's timeout answers.
#
# **Why this image and not the orchestrator.** Measured from `docker-compose.yml`
# rather than assumed: `app` runs `read_only`, `cap_drop: ALL`, `tmpfs` on /tmp
# and a 1 g memory limit; the orchestrator has neither `read_only` nor
# `cap_drop` and mounts the projects root read-write. The vault's uploads arrive
# here anyway, so the parser sits where the bytes already are and where the
# blast radius is smallest.
#
# **The honest difference from A104's gitleaks pin.** That one names a release
# tarball and verifies it by SHA-256, which an apt package cannot be: the
# archive is mutable and its revisions are transient. What takes the pin's place
# here is the digest-pinned base image — and the assertion below is what turns
# that from an implication into something observable, because a base that
# quietly changed release would fail this build instead of shipping a different
# parser. Measured, and the reason `2>&1` is not decoration: `pdftotext -v`
# writes its version to **stderr** and exits 0.
# =============================================================================
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends poppler-utils; \
    rm -rf /var/lib/apt/lists/*; \
    installed="$(pdftotext -v 2>&1 | sed -n 's/^pdftotext version \([0-9][0-9.]*\).*/\1/p' | head -n1)"; \
    if [ "$installed" != "${POPPLER_VERSION}" ]; then \
      echo "poppler-Pin verletzt: installiert '${installed}', erwartet ${POPPLER_VERSION}" >&2; \
      exit 1; \
    fi

# Never run as root (§19 container hardening). Beyond Node, the image ships
# exactly one added tool — poppler-utils above — and no other shell tooling.
RUN groupadd --gid 10001 vorschicht \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin vorschicht

COPY --from=build --chown=10001:10001 /out/server /app
COPY --from=build --chown=10001:10001 /out/web /app/public

ENV NODE_ENV=production
USER 10001:10001
EXPOSE 8420

# The healthcheck talks to the app's own /healthz, which reports liveness only
# (no session required, nothing leaked) — the same endpoint nginx and the host
# watchdog poll, so all three agree on what "healthy" means.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.APP_PORT||8420)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
