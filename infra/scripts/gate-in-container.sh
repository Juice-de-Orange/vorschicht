#!/usr/bin/env bash
# =============================================================================
# Run this project's own gate (§11) inside the environment it assumes.
#
#   infra/scripts/gate-in-container.sh [--only=lint,test] [--fail-fast]
#
# A wrapper since the demo scripts needed the same environment: everything this
# used to do lives in `in-container.sh`, including the reasoning for why the
# gate cannot run on a Windows checkout at all (A117).
#
# One trap worth knowing, because it looks like a broken checkout: `--only=<step>`
# does **not** build `packages/*/dist` first, so every test then reports "Failed
# to resolve entry for package". In a full run the typecheck step builds, and it
# is step one. For anything touching tests, take the full run.
#
# Exit codes are the gate's own (§11, A25): 0 green · 1 at least one finding ·
# 2 infra only — plus `in-container.sh`'s 2 for "nothing ran at all".
# =============================================================================
set -euo pipefail
exec "$(dirname "$0")/in-container.sh" pnpm gate "$@"
