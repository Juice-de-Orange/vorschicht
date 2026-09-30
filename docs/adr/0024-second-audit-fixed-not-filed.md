# ADR 0024 — When filing cannot yet work, audit findings are fixed in the same pass; four proofs the second audit strengthened

- **Status:** accepted
- **Date:** 2026-08-02
- **Context:** §8.2 (taxonomy, method), §22 Phase 0 gates 3–4, Phase 2 gate 2, Phase 3 gate 7
- **Condenses:** A76

## Decision

The Phase 3 close audit (`gate_truth`, 2026-08-02) returned `funde_zu_beheben`: no
`gate_invalid`, no `defect`, two `coverage_gap` and two `process` findings filed as P2 tasks —
into a throwaway database that vanished with the run (ADR 0021). Leaving four correctly
evidenced findings in that state on the way *out* of the phase whose audit produced them would
have been the failure ADR 0020 diagnosed, with the diagnosis already written down. They were
fixed instead of filed, and each is recorded here because the fix is the interesting part in
three of the four.

## What was found and what changed

1. **The image-layer check could not see file contents.** P0.G4 claims "zero hits in the
   image layers"; the only scripted evidence was `docker history --no-trunc | grep 'sk-ant-'`,
   which prints the *instructions* that built each layer. Verified by building two poisoned
   images: a token arriving by `COPY` was **not** detected, one set by `ENV` was. The
   replacement streams `docker export` — the flattened filesystem as an uncompressed tar —
   through one grep, so every byte of every file is read with no extraction and no scratch
   copy, plus a separate pass over `docker inspect .Config`, where the `ENV` case lives and
   which `docker export` does not carry. Each half catches what the other cannot; both were run
   against both poisons and a clean image. Two limits stated in the script: a file compressed
   inside the image is opaque, and the patterns are this project's four credential classes
   rather than gitleaks' full rule set — that set over a container filesystem finds npm test
   fixtures, and a permanently red check teaches everyone to stop reading it.
2. **`.env.example` was exempt from the secrets scan by path**, which switches off every rule
   for a file — including the two rules written for the credentials this project handles. The
   one versioned file that exists to show what a secret looks like was the one file no scan
   looked at. The auditor could not open it (its own read-hygiene hook denies `.env*`,
   ADR 0011) and inferred it from the config, which is the posture §8.2 asks for. The exemption
   turned out to be unnecessary: the regex allowlist covers every placeholder.
   `gitleaks-config.itest.ts` runs the production scanner over a scratch copy of the real
   config and the real file, once clean and once with a derived high-entropy token planted;
   re-adding the path kills two of its three cases.
3. **P0.G3's repeatable check read `authMethod` and never compared it.** It compared
   `apiProvider`, printed the method in the green line, and an API-key session reports
   `firstParty` too — so §2's hard rule would have been reported satisfied by the exact thing
   it forbids. Filed as `process` and not `gate_invalid`, correctly: the *property* is enforced
   by `self-check.ts` at daemon start with its own `api_key` test; what was missing was the
   check that reproduces the gate. Both halves are now compared, and so is the CLI version
   against `CLAUDE_CLI_VERSION`, which the gate text also claims and nothing had looked at
   (ADR 0014).
4. **An evidence line said more than its test did.** P2.G2 claimed `audit()` asserts §10's
   invariant "after every case"; it ran in three of seventeen. Nothing was invalidated — the
   gate's own sentence was proven elsewhere — but the line was what the next reader would
   believe. Lifted into an `afterEach` rather than softening the sentence: making the claim
   true is worth more than making it accurate, it costs one query per case, and a mutation
   confirms all seventeen now depend on it.

## Consequences

- The general shape, and the reason this is written down: **an over-claiming evidence line is
  invisible to every test in the repository**; its only readers are an auditor or a human.
  The class recurred on P4.G1, P5.G7, P5.G8, P6.G8 and P7.G5 and eventually produced the
  mechanical half of a guard (ADR 0025).
- Carried and not closed: one `suspicion` (the Phase 0 health check falls back to "running"
  for a service with no `HEALTHCHECK`; every service has one today, so it is inert) and seven
  `scope_limit` entries, the sharpest being that the auditor executed nothing at all — no
  shell, no git, no docker, no test run — so what it judged is what the tests and scripts
  *assert*, never that they are green at this commit.
- The regression sample worked as designed: the two closed `gate_invalid` findings of the first
  audit were re-examined and found genuinely fixed rather than reworded, and its `suspicion`
  about the integration tests was closed by ADR 0022.
- Fix-in-pass is the exception the missing infrastructure forced, not the rule. Once
  ADR 0021's persistent database existed, findings were filed and tracked, and the auditor's
  own findings pass closes them only on evidence that the fix task is `done` (A149.9).

## Evidence

- `infra/scripts/demo-phase0.sh` — the `docker export` scan (G4) and the both-halves auth and
  version comparison (G3).
- `packages/core/src/gitleaks-config.itest.ts`; `packages/core/src/claim-registry.itest.ts`
  (`afterEach`).
- `docs/pruefberichte/` — the Phase 3 close report, restored under its own id (ADR 0021).
