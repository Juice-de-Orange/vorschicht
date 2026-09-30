/**
 * §22's Phase-6 exit gate: "a planted fake secret in a transcript triggers the
 * P0 escalation naming the secret class."
 *
 * Against a real Postgres, real files on disk and the **real** gitleaks — the
 * same chooser the merge gate uses. A stub scanner here would make this a
 * statement about a fixture rather than about the mechanism: A55's lesson is
 * that the planted secret is the part most likely to be wrong, and only the
 * real scanner can tell you that it is.
 *
 * The token is derived from a fixed phrase rather than written out, so nothing
 * secret-shaped enters this repository while the bytes on disk still carry the
 * entropy gitleaks requires (`gitleaks-config.itest.ts:46-49`, A55).
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EscalationService } from '../escalation-service.js';
import { EventLog } from '../event-log.js';
import { AutoSecretScanner } from '../secret-scan.js';
import { TranscriptLeakScan } from './transcript-leak.js';

const url = process.env.TEST_DATABASE_URL;
const REPO_CONFIG = join(process.cwd(), '.gitleaks.toml');

/** High entropy on disk, nothing secret-shaped in this file (A55). */
function plausibleToken(): string {
  const body = createHash('sha256').update('vorschicht-transcript-leak-probe').digest('base64url');
  return `sk-ant-oat01-${body.slice(0, 40)}`;
}

describe.skipIf(!url)('TranscriptLeakScan', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let root: string;
  let clock = Date.parse('2026-08-09T22:00:00Z');

  beforeAll(async () => {
    database = await createTestDatabase('transcriptleak');
    sql = createSql({ url: database.url, max: 4 });
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vorschicht-transcripts-'));
    clock += 24 * 60 * 60_000;
  });

  async function transcript(day: string, runId: string, body: string): Promise<void> {
    await mkdir(join(root, day), { recursive: true });
    await writeFile(join(root, day, `${runId}.jsonl`), body, { mode: 0o600 });
  }

  function scan(): TranscriptLeakScan {
    const eventLog = new EventLog(sql);
    return new TranscriptLeakScan({
      transcriptsRoot: root,
      gitleaksConfigPath: REPO_CONFIG,
      scanner: new AutoSecretScanner(),
      eventLog,
      escalations: new EscalationService({ sql, eventLog }),
      now: () => clock,
    });
  }

  it('meldet einen sauberen Tag als sauber, ohne Karte', async () => {
    await transcript(
      '2026-08-20',
      'aaaaaaaa-0000-4000-8000-000000000001',
      '{"type":"assistant"}\n',
    );
    const outcome = await scan().run();
    expect(outcome.kind).toBe('clean');
  });

  it('findet ein gesätes Zugangsdatum und legt genau eine P0-Karte an (§6.6, A21)', async () => {
    await transcript(
      '2026-08-21',
      'aaaaaaaa-0000-4000-8000-000000000002',
      `{"text":"CLAUDE_CODE_OAUTH_TOKEN=${plausibleToken()}"}\n`,
    );

    const outcome = await scan().run();
    if (outcome.kind !== 'leak') throw new Error(`erwartet leak, war ${outcome.kind}`);

    expect(outcome.findings.length).toBeGreaterThan(0);
    const card = await new EscalationService({ sql, eventLog: new EventLog(sql) }).byNumber(
      outcome.escalation,
    );
    expect(card?.urgency).toBe('P0');
    expect(card?.source).toBe('transcript_leak');
    // The class, so the operator can rotate. The gate's own words.
    expect(card?.question).toContain('anthropic');
    // The file, so he knows where. Prefixed with its day.
    expect(card?.context).toContain('2026-08-21/');
  });

  it('bringt das Zugangsdatum weder in die Karte noch ins Ereignisprotokoll (A21)', async () => {
    const token = plausibleToken();
    await transcript(
      '2026-08-22',
      'aaaaaaaa-0000-4000-8000-000000000003',
      `{"text":"token=${token}"}\n`,
    );

    const outcome = await scan().run();
    if (outcome.kind !== 'leak') throw new Error(`erwartet leak, war ${outcome.kind}`);

    const card = await new EscalationService({ sql, eventLog: new EventLog(sql) }).byNumber(
      outcome.escalation,
    );
    expect(JSON.stringify(card)).not.toContain(token);

    // …and §18 keeps the event log forever, which is why this half matters more
    // than the card's half: a secret recorded here is unrecallable.
    const [row] = await sql<Array<{ payload: unknown }>>`
      SELECT payload FROM event_log WHERE kind = 'scan.finished' ORDER BY id DESC LIMIT 1
    `;
    expect(JSON.stringify(row?.payload)).not.toContain(token);
    expect(JSON.stringify(row?.payload)).toContain('anthropic');
  });

  it('meldet denselben Fund kein zweites Mal — sonst wäre es ein P0 pro Nacht', async () => {
    await transcript(
      '2026-08-23',
      'aaaaaaaa-0000-4000-8000-000000000004',
      `{"text":"token=${plausibleToken()}"}\n`,
    );

    const first = await scan().run();
    expect(first.kind).toBe('leak');

    // A second pass over the same day — which decision 1 guarantees happens,
    // because the current day is deliberately rescanned.
    const second = await scan().run();
    expect(second.kind).toBe('already_reported');

    // Scoped to this case's own day: `open()` is global and the neighbouring
    // cases in this file raise cards of the same source, so an absolute count
    // would measure them instead (A96, and the build log names the trap).
    const open = await new EscalationService({ sql, eventLog: new EventLog(sql) }).open();
    const mine = open.filter(
      (e) => e.source === 'transcript_leak' && e.context.includes('2026-08-23/'),
    );
    expect(mine).toHaveLength(1);
  });

  it('findet sein Gedächtnis auch unter 600 fremden Ereignissen wieder (A118)', async () => {
    /*
     * Der Fall, den der Radar-Strang beim Lesen dieser Datei gemeldet hat und
     * den der Nachbarfall oben nicht sehen kann: dort liegen zwischen den
     * beiden Läufen ein paar Zeilen, hier liegt dazwischen, was in diesem
     * System wirklich passiert. A101 hat 18 411 Zeilen aus **einem** Defekt in
     * einer Woche gezählt, A102 weitere 5 525 — 600 ist also keine Übertreibung,
     * sondern eine Stunde Normalbetrieb.
     *
     * Mit `recent(500)` über alle Arten ist die eigene Marke danach nicht mehr
     * in der Ergebnismenge, und das Ausbleiben liest sich als „noch nie
     * gescannt": §6.6 legt für einen Fund, den der Betreiber längst kennt, eine zweite
     * P0-Karte an. Das ist die Alarmsturm-Klasse, die dieses Projekt in A67.6,
     * A86.5 und A102 schon dreimal behoben hat.
     */
    await transcript(
      '2026-08-24',
      'aaaaaaaa-0000-4000-8000-000000000009',
      `{"text":"token=${plausibleToken()}"}\n`,
    );

    const first = await scan().run();
    expect(first.kind).toBe('leak');

    const laut = new EventLog(sql);
    for (let i = 0; i < 600; i += 1) {
      await laut.append({ kind: 'guardian.anomaly', actor: 'system', payload: { i } });
    }

    const second = await scan().run();
    expect(second.kind).toBe('already_reported');

    const open = await new EscalationService({ sql, eventLog: new EventLog(sql) }).open();
    const mine = open.filter(
      (e) => e.source === 'transcript_leak' && e.context.includes('2026-08-24/'),
    );
    expect(mine).toHaveLength(1);
  });

  it('nennt ein unlesbares Archiv infra und niemals sauber (A104.4)', async () => {
    const missing = new TranscriptLeakScan({
      transcriptsRoot: join(root, 'gibt-es-nicht'),
      gitleaksConfigPath: REPO_CONFIG,
      scanner: new AutoSecretScanner(),
      eventLog: new EventLog(sql),
      escalations: new EscalationService({ sql, eventLog: new EventLog(sql) }),
      now: () => clock,
    });
    const outcome = await missing.run();
    expect(outcome.kind).toBe('infra');
  });

  it('setzt die Marke fort, statt das Archiv jede Nacht neu zu lesen', async () => {
    await transcript('2026-08-24', 'aaaaaaaa-0000-4000-8000-000000000005', '{"ok":true}\n');
    const first = await scan().run();
    if (first.kind !== 'clean') throw new Error(`erwartet clean, war ${first.kind}`);
    expect(first.daysScanned).toBe(1);

    // A second day appears. The scan must cover it *and* the marker's own day
    // (which was still growing), and nothing older.
    await transcript('2026-08-25', 'aaaaaaaa-0000-4000-8000-000000000006', '{"ok":true}\n');
    const second = await scan().run();
    if (second.kind !== 'clean') throw new Error(`erwartet clean, war ${second.kind}`);
    expect(second.daysScanned).toBe(2);
  });
});
