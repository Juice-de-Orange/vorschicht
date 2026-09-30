# ADR 0011 — Credential files are denied to every session, and transcripts are scanned nightly

- **Status:** accepted
- **Date:** 2026-07-31
- **Context:** §6.6 (read hygiene, transcript leak scan), §19, §18
- **Condenses:** A21

## Decision

1. A `PreToolUse` hook denies **reads** of secret-shaped files anywhere in the mounted
   projects root: `.env*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `*.p12`,
   `credentials*`, `secrets*`, `.npmrc`, `.git-credentials`. The list is extendable per
   project via config. Agents learn from code, not from credentials.
2. A nightly gitleaks run scans every **new** transcript. Any hit raises a P0 inbox item
   naming the secret *class* and the file, so the operator can rotate immediately.

## Why

§6.6 deliberately lets agents read across the whole projects root — learning from the
operator's other code is wanted. That makes a deny-list of credential files the only thing
between a curious session and a deployed project's `.env`. It has to be a hook, not a prompt
instruction: a hook sees the tool that was invoked and can refuse `Read` on a path before it
executes. This is also why no role is granted shell readers like `cat` or `sed` (A46.3): a
hook can only pattern-match a shell line, so shell readers would be a second, unenforceable
read path that buys nothing and costs the guarantee.

The transcript scan exists because the hook covers the mount, not the model's memory: a secret
pasted into a prompt by a human, printed by a build tool, or present in a file the patterns do
not name will land in a transcript, and transcripts are kept for a year (A15).

## Consequences

- `.env.example` and its three siblings are exempt from the `.env*` pattern (A51.3): they are
  committed documentation that every session is obliged to keep current, and denying the read
  while permitting the write would be incoherent. A real secret in a git-visible file is
  caught by `gate:secrets` instead — a layer that does not depend on this one, and one that
  since ADR 0024 no longer exempts that file by path. Patterns match case-insensitively,
  exceptions case-sensitively: an exception should be harder to hit by accident than a denial.
- The hook's policy is a per-run **file**, not a database query (ADR 0004): a hook that asked
  Postgres whether a path is allowed would stop containing anything the moment the database
  hiccupped, and a file it cannot read denies everything.
- The nightly scan's unit is the **day directory** of the transcript archive, re-scanned
  inclusively because the directory was still growing when read. Findings are de-duplicated
  by (file, rule) without the line number — a growing transcript shifts lines and would
  otherwise re-raise the same P0 every night (A105). One card per run, not per finding.
- A scan that could not read is `infra` and never "clean": `gitleaks dir` on a missing
  directory exits 0 with an empty list, and so does an unreadable file (A104.4). The rule file
  is passed explicitly; without it a real token in a transcript went undetected by mutation.
- The scan's watermark is read with `recentOfKind`, not a global `recent(n)`: on a busy day
  hundreds of events pass in an hour, and a lost watermark reads as "never scanned", which
  produces a second P0 for a leak the operator already knows about (A118).
- The card and the event log carry class and file, never the match itself — structurally,
  since `SecretScanFinding` has no field for it (A105.4). The event log is kept forever.

## Evidence

- `packages/shared/src/containment.ts` — the pattern list and decision logic;
  `infra/scripts/check-hook-containment.mjs` — one real session against the pinned CLI, the
  denial asserted on the filesystem afterwards (P2.G3).
- `packages/core/src/scans/transcript-leak.ts` with `transcript-leak.itest.ts` against the
  real gitleaks binary — a stub would make it a statement about a fixture (A55);
  `packages/core/src/secret-scan.ts` — `AutoSecretScanner`.
- P6.G4 in `CLAUDE.md` §22 — 27 cases, exactly one P0 card for a planted derived credential.
