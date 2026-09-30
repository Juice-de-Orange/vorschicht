/**
 * The greps that are all there is against `main.ts` losing a caller.
 *
 * Stated where it applies rather than left to be discovered: **`main.ts` has no
 * test**, which is exactly how `EscalationMailService.tick()` came to have no
 * caller at all (A86) and how `JobQueue` came to be constructed nowhere (this
 * commit). Deleting a wiring line from that file kills nothing in
 * `periodic-pass.itest.ts`, `work-gate.test.ts` or `disk-watch.test.ts` — every
 * one of them drives its subject directly.
 *
 * These assertions prove the call sites *exist*, never that they are reached.
 * That is the honest limit, and it is the same one `backup-pass.test.ts`
 * records; the alternative is restructuring an entry point that is outside this
 * change.
 *
 * The pure half of the pass is deliberately not here: its whole behaviour is
 * "what does the event log say", and a stub for that would let the suite assert
 * whatever it was told. It lives in `periodic-pass.itest.ts`, against a real
 * database.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DISK_CHECK_INTERVAL_MS } from './disk-watch.js';

const repoRoot = join(import.meta.dirname, '../../..');
const main = readFileSync(join(repoRoot, 'apps/orchestrator/src/main.ts'), 'utf8');

describe('die Verdrahtung in main.ts', () => {
  it('ruft den periodischen Pass in der Schleife auf', () => {
    expect(main).toContain('runPeriodicPass({ jobs: periodicJobs');
  });

  it('registriert die Plattenwacht mit der Kadenz, die sie selbst nennt', () => {
    // Two halves of one fact: the job exists, and its interval is the module's
    // constant rather than a number typed twice. A literal here would be the
    // second place the cadence lives, and the two would part company silently.
    expect(main).toContain("lastRunKind: 'disk.checked'");
    expect(main).toContain('intervalMs: DISK_CHECK_INTERVAL_MS');
  });

  it('registriert §6.6s Transkript-Scan als zweiten Auftrag (A105)', () => {
    // The scan and the cadence were built in the same block and neither one
    // reaches the other by itself. That is the shape A86 found — `tick()` with
    // no caller — and this repository has now produced it twice, so the net is
    // here rather than in a demo script that runs when somebody remembers.
    expect(main).toContain("name: 'transcript-leak'");
    expect(main).toContain("lastRunKind: 'scan.finished'");
    expect(main).toContain('new TranscriptLeakScan({');
    // The rules file is passed, never discovered: without it gitleaks falls
    // back to its defaults and A104's mutation M2 measured what that costs — a
    // `sk-ant-oat` token in a transcript goes undetected.
    expect(main).toContain('gitleaksConfigPath: config.gitleaksConfigPath');
    expect(DISK_CHECK_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('gibt der Plattenwacht das Transkriptverzeichnis, das sie aufräumen darf', () => {
    // Decision 7's blast radius, asserted at the call site: the prune only ever
    // touches what this argument names.
    expect(main).toContain('transcriptsRoot: config.transcriptsRoot');
  });

  it('verdrahtet die echte Warteschlange als Tor des Wächters (§7.2, §4)', () => {
    // The line this commit exists for: `JobQueue` was constructed nowhere in
    // production while three comments said pg-boss carried the studio's work.
    expect(main).toContain('new JobQueue({');
    expect(main).toContain('new WorkGate({ queue: jobQueue');
    expect(main).toContain('queue: workGate');
    // And it is started after the schema it does not share, because pg-boss
    // builds its own in `start()`.
    expect(main.indexOf('await migrate(sql)')).toBeLessThan(main.indexOf('workGate.start()'));
    expect(main).toContain('await workGate.stop()');
  });

  it('meldet §8.2 einen beendeten Auth-Vorfall', () => {
    // `requestAudit` had no production caller at all, so `post_auth_incident`
    // and `gate_flip` were two of eight `AUDIT_TRIGGERS` nothing could reach.
    expect(main).toContain('requestAudit: (trigger) => scheduler?.requestAudit(trigger)');
  });

  it('lässt den alten In-Memory-Stub nicht zurückkommen', () => {
    // The shape being replaced, named so that a revert is visible rather than
    // plausible: an object literal with a boolean where the queue should be.
    expect(main).not.toContain('const workGate = {');
  });
});
