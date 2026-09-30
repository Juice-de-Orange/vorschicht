# ADR 0016 — Exit gates may be deferred to the target host, never softened

- **Status:** accepted
- **Date:** 2026-08-01
- **Context:** §0.2, §0.3, §22 (phase plan), Phase 9 exit gates
- **Condenses:** A38

## Decision

An exit gate whose **only** remaining blocker is an artefact of the target host or an action
physically reserved to the operator — public DNS/TLS, the host nginx, system-level systemd, a
personal OAuth or passkey action, a phone, a mail account, an external service that does not
exist yet — is neither ticked nor weakened. It is marked `[~] deferred-to-target-host` **and
must ship with the scripted verification run that will prove it on the production host**. A
phase may proceed when every gate is green or deferred-with-script.

Counterweight: Phase 9 carries an exit gate "every deferred gate from Phases 0–8 executed on
the production host and green". The gate is terminated rather than softened: it blocks
acceptance instead of blocking the build. *(Decision by the operator, 2026-08-01.)*

## Why

§0.2 says a phase is finished only when every gate is ticked, no exceptions. §0.3 forbids
weakening a gate to make it pass. Taken literally together, a gate that needs the operator's
phone would stop the build until he happened to be at his phone — and the temptation would be
to reword the gate so a fixture satisfies it. Both outcomes are worse than naming the
dependency. The deferral makes the missing half explicit, the script makes the deferral honest,
and the Phase 9 gate makes sure the debt is paid before "done".

## Consequences

- A deferral is only one if its script has **run**. `check-static-rsync.mjs` was executed
  against a scratch path on the production host before P5.G2 was marked deferred (four of four
  green, nothing left behind) — that proves the script and the mechanism, not the gate, and the
  evidence line says which (A99.5). Each script's refusal paths (no target, host unreachable,
  a missing precondition) exit 2, because "nothing checked" is not a finding (ADR 0013).
- A deferral note that names more missing work than there is misleads the next reader as badly
  as an over-claiming tick. The Phase 4 audit filed exactly that as a `process` finding on
  P4.G1, whose note said the UI and the notification were missing when both had been built
  since; the note was corrected to "only the operator's device is missing" (ADR 0024's class).
- Six of the scripts that carried deferrals could not start on the build machine, because
  `await import()` received a Windows path instead of a `file://` URL — right by accident on
  Linux, never on Windows (A130). A deferral whose script does not start where it was written
  is a counterweight without weight. `script-imports.test.ts` now refuses any dynamic import
  that is not a literal specifier or `pathToFileURL`.
- The documentation guard (ADR 0025) treats `[~]` as closed for the phase tally and requires
  an evidence bracket on every deferred line, exactly as on a ticked one.
- The gates deferred at the time of this record: P4.G1 (the operator's phone), P5.G2 (a real
  static-rsync release host), P6.G2 and P6.G5 (a writable pilot project, ADR 0017), P8.G1
  (the operator's mail account and the SMTP variables that are still empty in the host's
  `.env`). Each names its script in its evidence line.
- The final audit of Phase 9 re-examines every deferred gate against its host run, so a
  deferral cannot be forgotten by being ticked later without one.

## Evidence

- `infra/scripts/check-static-rsync.mjs`, `check-radar-autotask.mjs`, `check-idle-audit.mjs`,
  `demo-phase4.sh` (remote mode) — the shipped verification runs.
- `infra/scripts/script-imports.test.ts` — the `pathToFileURL` guard.
- `infra/scripts/gate-doku.mjs` — counts `[~]` as closed and demands the evidence bracket.
