# Prüfberichte — sample reports of the internal audit (§8.2)

Every run of the Betriebsprüfung writes a German report (the audit's output is user-facing, like the
dashboard, so it stays German by §2) with a fixed structure — 1. scope and sample · 2. confirmed
findings with evidence · 3. suspicions · 4. what could not be checked · 5. revised assumptions ·
6. verdict — and exactly one verdict from a closed set: `unbedenklich`, `funde_zu_beheben`,
`phase_nicht_abschliessbar`.

The checked-in file is the **durable** part of the evidence (A56, A92): a report is never edited
after the fact. Four of the fifteen runs of the original build are kept here as samples; the file
name is produced by `pruefberichtDateiname()` and carries the audit id that the report's first line
carries (`packages/core/src/audit/report.test.ts` asserts that for every file in this directory).

| Date | Id | Domain | Trigger | Verdict | Findings | Why it is here |
|---|---|---|---|---|---|---|
| 2026-08-02 | [`67ac096c`](2026-08-02-67ac096c-gate_truth.md) | gate_truth | manual | `phase_nicht_abschliessbar` | 1 `gate_invalid`, 2 `defect`, 1 `coverage_gap`, 1 `process` | The audit un-ticked P0.G7: the watchdog demo proved a syslog line, not an ntfy delivery. All three findings sat in the same script. `demo-phase4.sh` cites this report. |
| 2026-08-18 | [`49c549b4`](2026-08-18-49c549b4-gate_truth.md) | gate_truth | phase_close | `phase_nicht_abschliessbar` | 1 `gate_invalid`, 1 `suspicion` | Run against the Phase 7 candidate rather than the deployed tree. Its finding on the regression sample P0.G5 was six hours old and held: the gate sentence contradicted the test. `demo-phase7.sh` cites this report. |
| 2026-08-25 | [`52a68316`](2026-08-25-52a68316-gate_truth.md) | gate_truth | phase_close | `phase_nicht_abschliessbar` | 1 `gate_invalid`, 1 `defect`, 2 `coverage_gap`, 1 `process` | Found that the documentation guard read two files while the README's tally sat three ticks behind — the reason `gate-doku.mjs` now reads every document that claims a state (A151, A152). |
| 2026-08-25 | [`ceed365f`](2026-08-25-ceed365f-dead_wiring.md) | **dead_wiring** | phase_close | `funde_zu_beheben` | 4 `defect`, 1 `coverage_gap` | The first run of a domain other than gate truth found four defects on its first pass, among them a validator with no caller. A domain that never runs is itself dead wiring. |

Of the eight audit domains, five ran during the build (`gate_truth` ×10, `dead_wiring`,
`claim_vs_evidence`, `test_substance`, `assumption_revision`); `containment_boundaries`,
`process_compliance` and `number_reconciliation` never did. The Phase 9 exit gate P9.G8 requires
every domain at least once. `demo-phase9.sh` computes that coverage from this directory rather than
stating it.

## How a new run is produced

```
infra/scripts/audit-remote.sh --host <ssh-host> --domain <domain> --trigger phase_close [--baum <path>]
```

It runs in the gate image on the host, against the live database, so that findings reach the
operator's inbox and §8.2's "a dismissal is re-opened exactly once" holds across runs (A135). A run
without a durable database is refused (A117). The report lands here, named by
`pruefberichtDateiname()`, and is compared byte-for-byte against `audits.report`.
