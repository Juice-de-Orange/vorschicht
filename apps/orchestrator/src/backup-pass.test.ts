/**
 * The two pure halves of §18's backup pass, plus the two greps that are all
 * there is against drift across a language boundary.
 *
 * The pass itself is proved against a real Postgres and real files in
 * `backup-pass.itest.ts` — the properties that matter (one event per run, one
 * notification per transition, nothing repeated across passes) are properties
 * of a *memory*, and that memory is a row in `event_log`. Stubbing it would let
 * this suite assert whatever it was told.
 *
 * What is here instead is what does not need a database: the reader's own
 * refusals, the transition rule, and two assertions about files this module
 * cannot typecheck against.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BACKUP_COMPONENTS,
  BACKUP_RESULT_SCHEMA,
  decideTransition,
  parseBackupResult,
} from './backup-pass.js';

const repoRoot = join(import.meta.dirname, '../../..');

/** What `backup-run.sh` writes after a clean night. */
const CLEAN = [
  'schema=1',
  'started_at=1754180000',
  'finished_at=1754180042',
  'stamp=20260803-023000',
  'outcome=ok',
  'db=ok',
  'docs=ok',
  'transcripts=ok',
  'prune=ok',
  'problem=',
].join('\n');

describe('parseBackupResult', () => {
  it('liest einen sauberen Lauf', () => {
    const parsed = parseBackupResult(`${CLEAN}\n`);

    expect(parsed).toEqual({
      ok: true,
      result: {
        finishedAt: 1754180042,
        startedAt: 1754180000,
        stamp: '20260803-023000',
        outcome: 'ok',
        components: { db: 'ok', docs: 'ok', transcripts: 'ok', prune: 'ok' },
        problem: null,
      },
    });
  });

  it('behält die Bestandteile eines Teilerfolgs einzeln', () => {
    // Genau der beobachtete Fehlschlag: pg_dump und docs liefen, die
    // Transkripte waren nicht lesbar, prune kam nie dran. Ein Boolean hätte
    // die einzige Aussage weggeworfen, auf die es ankommt.
    const parsed = parseBackupResult(
      [
        'schema=1',
        'finished_at=1754180042',
        'outcome=failed',
        'db=ok',
        'docs=ok',
        'transcripts=failed',
        'prune=skipped',
        'problem=tar für transcripts fehlgeschlagen',
      ].join('\n'),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.components).toEqual({
      db: 'ok',
      docs: 'ok',
      transcripts: 'failed',
      prune: 'skipped',
    });
    expect(parsed.result.problem).toBe('tar für transcripts fehlgeschlagen');
  });

  it('lässt ein `=` im Problemtext stehen, statt an ihm zu zerbrechen', () => {
    // Der Text kommt aus einem Werkzeug. Würde hier auf jedem `=` getrennt,
    // wäre die Meldung genau dann unbrauchbar, wenn sie einen Pfad nennt.
    const parsed = parseBackupResult(
      [
        'schema=1',
        'finished_at=7',
        'outcome=failed',
        'problem=pg_dump --file=/backups/x fiel',
      ].join('\n'),
    );

    expect(parsed.ok && parsed.result.problem).toBe('pg_dump --file=/backups/x fiel');
  });

  it('verweigert ein Dokument mit fremdem Schema, statt Felder daraus zu lesen', () => {
    const parsed = parseBackupResult(['schema=2', 'finished_at=7', 'outcome=ok'].join('\n'));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    // Die Meldung nennt beide Zahlen: sonst weiß der Leser der Zeile nicht,
    // welche der beiden Hälften sich bewegt hat.
    expect(parsed.problem).toContain('schema=2');
    expect(parsed.problem).toContain(String(BACKUP_RESULT_SCHEMA));
  });

  it('verweigert einen Lauf ohne finished_at — er wäre nicht unterscheidbar', () => {
    // Ohne diese Zahl gibt es keine Identität, und ohne Identität meldet der
    // Durchlauf denselben Lauf bei jedem Tick erneut.
    const parsed = parseBackupResult(['schema=1', 'outcome=ok', 'db=ok'].join('\n'));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem).toContain('finished_at');
  });

  it('verweigert ein unbekanntes outcome, statt es als Erfolg zu lesen', () => {
    const parsed = parseBackupResult(
      ['schema=1', 'finished_at=7', 'outcome=vielleicht'].join('\n'),
    );

    expect(parsed.ok).toBe(false);
  });

  it('nennt einen fehlenden Bestandteil `unbekannt` und nicht `ok`', () => {
    // Drift zwischen Skript und Leser darf nicht wie ein sauberer Lauf
    // aussehen — das ist derselbe Fehler eine Ebene höher.
    const parsed = parseBackupResult(
      ['schema=1', 'finished_at=7', 'outcome=ok', 'db=ok'].join('\n'),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.components.transcripts).toBe('unbekannt');
  });

  it('überliest eine abgeschnittene Zeile, statt das ganze Dokument zu verwerfen', () => {
    // Der Grund für `key=value` statt JSON: ein halber Schreibvorgang kostet
    // eine Zeile, kein Dokument.
    const parsed = parseBackupResult(`${CLEAN}\nfinished_a`);

    expect(parsed.ok).toBe(true);
  });
});

describe('decideTransition', () => {
  it('meldet nur den Wechsel, nicht den Zustand', () => {
    expect(decideTransition({ outcome: 'ok' }, 'failed')).toBe('failure');
    expect(decideTransition({ outcome: 'failed' }, 'ok')).toBe('recovery');
    // A67.6/A86.5: ein Kanal, der jede Nacht dasselbe meldet, wird stummgeschaltet.
    expect(decideTransition({ outcome: 'failed' }, 'failed')).toBeNull();
    expect(decideTransition({ outcome: 'ok' }, 'ok')).toBeNull();
  });

  it('ist beim allerersten Lauf absichtlich unsymmetrisch', () => {
    // Die erste aufgezeichnete Sicherung, die fehlschlug, muss gemeldet werden —
    // die erste, die gelang, hat nichts zu melden.
    expect(decideTransition(null, 'failed')).toBe('failure');
    expect(decideTransition(null, 'ok')).toBeNull();
  });
});

/**
 * The producer is `sh` and the consumer is TypeScript, so nothing can typecheck
 * one against the other (A81's defect shape without A81's remedy — `sh` cannot
 * import a zod schema). These two greps are what is left, and their weakness is
 * stated rather than implied: they prove a string appears in a file, never that
 * it is written on every path or that the call is reached at runtime.
 */
describe('Verdrahtung und Format, mechanisch nachgeprüft', () => {
  const script = readFileSync(join(repoRoot, 'infra/scripts/backup-run.sh'), 'utf8');

  it('backup-run.sh schreibt jeden Schlüssel, den der Leser braucht', () => {
    for (const key of ['finished_at', 'outcome', ...BACKUP_COMPONENTS]) {
      expect(script, `backup-run.sh schreibt kein ${key}=`).toContain(`printf '${key}=%s\\n'`);
    }
    // Die Schemazahl ist im Skript ein Literal, kein `%s` — sie ist eine
    // Eigenschaft des Dokuments und nicht des Laufs — und sie muss die sein,
    // die dieser Leser verlangt.
    expect(script).toContain(`printf 'schema=${BACKUP_RESULT_SCHEMA}\\n'`);
  });

  it('main.ts ruft den Durchlauf auf', () => {
    // Die schwächste Stelle dieser Änderung, hier festgehalten statt
    // stillschweigend hingenommen: `main.ts` hat keinen Test, und genau so kam
    // `EscalationMailService.tick()` dazu, überhaupt keinen Aufrufer zu haben
    // (A86). Dieser grep ersetzt das nicht, er macht nur das Löschen der
    // Aufrufzeile sichtbar.
    const main = readFileSync(join(repoRoot, 'apps/orchestrator/src/main.ts'), 'utf8');

    expect(main).toContain('runBackupPass({');
    expect(main).toContain('resultPath: config.backupResultPath');
  });
});
