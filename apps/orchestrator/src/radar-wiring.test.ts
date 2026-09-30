/**
 * The net under the radar's call site in `main.ts`.
 *
 * `main.ts` has no test, and this repository has produced a mechanism with no
 * caller four times now: `EscalationMailService.tick()` (A86), `JobQueue`
 * (A74.2), `gate:commits` (A71), and §6.6's transcript scan, which had a source
 * in `ESCALATION_SOURCES` and no producer for two phases (A105). Deleting the
 * registration below would kill nothing in `scan.itest.ts`, which drives
 * `RadarScan` directly.
 *
 * Its own file rather than assertions appended to `periodic-pass.test.ts`: that
 * is the house pattern (`backup-pass.test.ts` and `sources-pass.test.ts` each
 * carry their own grep), and it keeps three agents out of one file.
 *
 * The honest limit, the same one `backup-pass.test.ts` and `periodic-pass.test.ts`
 * both record: these assertions prove the call site **exists**, never that it is
 * reached. Restructuring an entry point is outside this change.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RADAR_INTERVAL_MS } from '@vorschicht/core';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '../../..');
const main = readFileSync(join(repoRoot, 'apps/orchestrator/src/main.ts'), 'utf8');

describe('die Verdrahtung des Radars in main.ts', () => {
  it('registriert den Radar als periodischen Auftrag', () => {
    expect(main).toContain("name: 'radar'");
    expect(main).toContain('new RadarScan({');
    // Two halves of one fact, as `periodic-pass.test.ts` puts it: the job
    // exists, and its cadence is the module's constant rather than a number
    // typed twice — a literal here would be the second place the cadence lives.
    expect(main).toContain('intervalMs: RADAR_INTERVAL_MS');
    expect(RADAR_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('gibt ihm eine eigene Frist und nicht die des Transkript-Scans', () => {
    // The defect this avoids is silent and one-directional: sharing
    // `scan.finished` would make §6.6's nightly leak scan look as though it had
    // just run, every six hours, forever. `periodic-pass.ts` dates a job by the
    // newest row of its `lastRunKind`, so two jobs need two kinds.
    expect(main).toContain("lastRunKind: 'radar.finished'");
    const radar = main.slice(main.indexOf("name: 'radar'"));
    expect(radar).not.toContain("lastRunKind: 'scan.finished'");
  });

  it('gibt ihm den echten Kanal, nicht die Fixture', () => {
    // A88.7's posture. Wired by accident, `FixtureRadarFeeds` would report a
    // clean billing channel that nobody queried — for §6.0's #1 external risk.
    expect(main).toContain('new HttpRadarFeeds({');
    // `new`, not the bare name: the comment above the registration says
    // "`HttpRadarFeeds` and never `FixtureRadarFeeds`", and an assertion that
    // banned the word would make writing down the reason break the test.
    expect(main).not.toContain('new FixtureRadarFeeds');
  });

  it('vergleicht gegen die festgenagelte CLI-Version aus der Konfiguration', () => {
    // A27's pin is what the channel is compared against; a literal here would
    // let the image move and the radar keep watching the old number.
    expect(main).toContain('pinnedCliVersion: config.claudeCliVersion');
  });

  it('gibt ihm die Kanäle aus der Konfiguration, ohne eine URL zu erfinden', () => {
    expect(main).toContain('billingUrls: config.radarBillingUrls');
    expect(main).toContain('cliUrl: config.radarCliUrl');
  });

  it('protokolliert die ungeprüften Flächen und nicht nur die Funde', () => {
    // The run this matters in is the one that found nothing: without the limits
    // a scan that queried no channel at all reads exactly like a clean one
    // (A83.6, A99.4, A104.4 — three subsystems, one rule).
    expect(main).toContain('for (const limit of outcome.limits)');
  });
});
