# ADR 0007 — Model access authenticates with a long-lived subscription token kept in one volume

- **Status:** accepted
- **Date:** 2026-07-31
- **Context:** §2 (Claude usage), §6.0, §6.1, §7.1
- **Condenses:** A5

## Decision

- The only credential is a long-lived OAuth token minted once with `claude setup-token` on a
  trusted machine, stored **only** in the claude auth volume and injected into the
  orchestrator container as `CLAUDE_CODE_OAUTH_TOKEN`.
- A one-turn smoke session must succeed before the daemon accepts any work. Failure is an
  auth incident (§6.1): the daemon idles and alerts, affected tasks are parked, never marked
  red.
- Token age is monitored (A28): a warning at 30 days remaining, a P0 inbox item at 7.
- No API key, no usage credits, ever (§2 hard rule). The `api-key` backend exists only as a
  designed seam (ADR 0015).

## Why

The subscription is the whole economic premise. An interactive claude.ai credential would give
the same access but is known to fail to refresh in non-interactive mode, which is the one
failure a 24/7 daemon cannot ride out; a setup token lives about a year and needs no refresh.
Keeping it in a single volume that only the orchestrator mounts is what makes §19's "secrets
never in prompts" checkable: the CLI strips the variable before spawning hooks (ADR 0004), and
nothing else reads it.

The smoke session exists because a dead token must never look like a failed task. Without it
the first symptom would be fifteen red tasks with a 401 buried in each transcript.

## Consequences

- **The price of this auth mode was discovered later (A64, ADR 0005):** under token auth the
  CLI reports `rate_limits_available: false`, so the official utilisation figure is not
  available on demand. Only above the vendor's 75 % warning threshold does a
  `rate_limit_event` carry a number (ADR 0023). Below that band the estimating meter governs.
  The decision stands; its cost is now stated instead of implied. The alternative — mounting
  an interactive credential into the auth volume — would restore the on-demand figure at the
  price of an auth that can die unattended and a personal credential on a publicly reachable
  host. Recorded as the operator's decision, not taken.
- The smoke probe runs **ahead of** the guardian, not behind it (A58): §7.1's official reading
  comes from a live session, and a guardian with no samples correctly refuses to start work —
  so gating the probe on the guardian's verdict would make an empty meter unrecoverable on a
  fresh installation. The probe is one economy-tier turn, no tools, no task.
- The token never leaves the host. When the internal audit had to run in a container, carrying
  the token to the build machine was considered and rejected on the strength of this decision
  (A135); the audit runs on the production host instead.
- Rotation is the operator's: the studio can detect an expiring or dead token but never mints
  a new one, and never sees a new value.

## Evidence

- `apps/orchestrator/src/self-check.ts` — `assertSubscriptionAuth` compares both `authMethod`
  and `apiProvider` (the second comparison was added after the second audit found the demo
  script printing the method without checking it, ADR 0024).
- `apps/orchestrator/src/incident-cycle.ts` and `incident-cycle.test.ts` — the auth-incident
  loop: park once, alert on the alerts topic, resume exactly what was parked.
- P0.G3 and P1.G5 in `CLAUDE.md` §22.
