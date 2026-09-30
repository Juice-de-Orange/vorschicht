/**
 * The pure half of the gate runner's classification (§11, A25, A50).
 *
 * Split out of `gate.mjs` for A68's reason, which was learned the hard way one
 * directory over: `gate.mjs` runs the whole suite at import time, so a test that
 * imported it to check one decision would execute every gate step instead —
 * and would pass whether or not the decision it meant to pin was correct.
 * The decision lives here, the side effect lives there.
 *
 * ## What this file gets right that its caller got wrong
 *
 * A50 settled that a third-party tool has *any* non-zero exit read as a
 * finding, because `tsc` exits 2 on a plain type error and reading that as
 * infrastructure turns a blocker into a retry. That reasoning is correct and it
 * is about a process that **ran**.
 *
 * It says nothing about a process that never started — and `spawn` has two
 * separate ways of saying so: an asynchronous `error` event (the binary is not
 * executable, `pnpm.cmd` on win32) and a synchronous throw (`EFTYPE`, a `.sh`
 * on win32). The old runner mapped the first to exit code 2 and let the second
 * crash the whole run. Exit code 2 then met `classify: 'any-failure'` and came
 * out as a **FINDING** — a §11 blocker — for typecheck, lint, test and build.
 *
 * Observed, not hypothesised: on 2026-08-16 a Windows checkout reported four
 * red "code problems" while not one process had started. That is the direction
 * A25 exists to forbid — "nichts geprüft" is not a finding, it is the absence
 * of one, and a blocker that nobody can fix by fixing code is how a gate gets
 * ignored.
 *
 * So `spawned` outranks everything. It is not a code, because a code is what a
 * process returns and this is the case where there was no process.
 */

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   cmd: string[],
 *   optional?: boolean,
 *   classify?: 'a25' | 'any-failure',
 * }} Step
 *
 * @typedef {{
 *   step: Step,
 *   code: number,
 *   ms: number,
 *   spawned: boolean,
 *   reason?: string,
 * }} StepResult
 *
 * @typedef {'green' | 'finding' | 'infra'} Verdict
 */

/**
 * @param {StepResult} result
 * @returns {Verdict}
 */
export function verdict(result) {
  // First, and above `classify`: a step that never started checked nothing.
  // A25 calls that infrastructure whatever the step's exit-code dialect is,
  // because the dialect describes what a tool *reports* and nothing reported.
  if (!result.spawned) return 'infra';
  if (result.code === 0) return 'green';
  // A50, unchanged: third-party tools never promised our codes.
  if (result.step.classify === 'any-failure') return 'finding';
  return result.code === 1 ? 'finding' : 'infra';
}

/**
 * The German for every ending, in one place. Change the wording here, never in
 * the branch that produced the verdict — `retryDetail()` in `gate-suite.ts`
 * keeps the same rule for the same reason.
 *
 * @param {StepResult} result
 * @returns {string}
 */
export function label(result) {
  const state = verdict(result);
  if (state === 'green') return 'grün';
  if (!result.spawned) {
    // Naming the cause matters more here than anywhere else in this file: the
    // reader's next move is to fix their machine, not their code, and "exit 2"
    // sends them to the wrong place.
    return result.reason ? `INFRA (nicht gestartet: ${result.reason})` : 'INFRA (nicht gestartet)';
  }
  return state === 'finding' ? `FINDING (exit ${result.code})` : `INFRA (exit ${result.code})`;
}
