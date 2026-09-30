# ADR 0012 — A host-level watchdog outside the compose stack; a full host outage is consciously unmonitored

- **Status:** accepted
- **Date:** 2026-07-31
- **Context:** §18.1, §3 (Compose services), §16
- **Condenses:** A23

## Decision

- A systemd timer on the production host, **outside** the compose stack
  (`infra/systemd/vorschicht-watchdog.{service,timer}`, `infra/scripts/watchdog.sh`), runs
  every 2 minutes and checks container health states plus the orchestrator heartbeat.
- On failure or absence: one ntfy alert and **one** `docker compose start` attempt for stopped
  services, audit-logged. Repeated failure → alert only, no restart loop.
- A full outage of the host itself is **not** monitored. ntfy is routed through the same host,
  so no alert path would exist; this is a hobby-homelab decision by the operator, documented
  rather than mitigated.

## Why

The compose stack cannot watch itself: a hung docker daemon or a stopped orchestrator
container is invisible from inside. A systemd timer is the cheapest component on the host that
survives the stack going down. A single restart attempt is the line between "recover from a
transient" and "flap forever": a service that fails twice in a row needs a human, and a
restart loop on a shared host is a way to take the host's other services down with it.

An external monitor for the host would have meant a second machine or a paid service with its
own credential, for a personal system whose owner would rather learn about a host outage by
noticing the phone is quiet. The blind spot is written down so that a silent Thursday is read
as one.

## Consequences

- The first version throttled **restarts** and not **alerts** (A102). Measured on the host
  during a week-long unhealthy `backup` container: 5,525 journal lines and 2,026 delivered
  pushes for one incident, about 290 a day — a channel that gets muted, after which the next
  real alert is invisible. The state file now carries two fields, `failing <since> <reported>`:
  the restart latch flips **on the attempt**, the alert throttle only on a **delivered** alert.
  One field cannot hold both rules; the mutation that merges them turns exactly the A23
  assertion red. For the same incident: 29 pushes instead of 2,026, plus a recovery push and a
  six-hourly reminder saying how long it has lasted.
- `alert()` has three outcomes — delivered, rejected, no channel configured — and only
  "rejected" keeps the reported timestamp from advancing. An unreachable docker daemon is now a
  problem like any other and suppresses the start attempt that could not work anyway.
- The demo for P0.G7 asserts **delivery**, not detection. The audit closing Phase 4 found
  `watchdog.sh` writing its journal line *before* the ntfy block, behind an `if` with a
  swallowing `||`, so the script was green on a host where ntfy was unreachable: it proved
  "writes a syslog line" while the gate said "raises an ntfy alert". Detection and delivery
  are now two separate journal lines, `curl -f` is evaluated, the topic comes from
  `NTFY_TOPIC_ALERTS` rather than being hard-coded, and the demo anchors on a timestamp instead
  of a five-minute window that had read the previous run's line.
- The host run was repeated after A102 changed the script: an evidence line that cites a run
  of a script version that no longer exists carries nothing, and the audit of 2026-08-24
  demanded exactly that repetition as a `gate_invalid` (A156.2).
- The demo without systemd refuses with exit 2 and says so: "this run proves the throttling and
  NOT P0.G7" — nothing checked is not a finding (ADR 0013).

## Evidence

- `infra/scripts/watchdog.sh` — topic from configuration, three-valued `alert()`, two-field
  state; `infra/scripts/demo-watchdog.sh` — 22 assertions, five mutations each killed in the
  expected direction.
- P0.G7 in `CLAUDE.md` §22 — the host run: kill → detected within one interval → the
  delivery line in the journal → `failing`, alert only.
