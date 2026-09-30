/**
 * The two halves of §11's migration gate that need no model and no database
 * (A63): which files count as a migration, and what the session is told.
 *
 * The gate's *decision* — what a delivered review means for the merge — lives in
 * `gate-suite.ts` beside the other gate verdicts and is tested there, together
 * with the two cases where no review happens at all.
 *
 * Detection is the half worth testing hardest, because it is the half that
 * decides whether a session is spawned. A false negative merges an unreviewed
 * schema change and then deploys it, where §12's rollback restores the previous
 * release's *code* and cannot undo it. A false positive costs one session and
 * says so in the gate's own detail line. The assertions below are written in
 * that direction.
 */
import { EMPTY_GATE_CONFIG, type ProjectGateConfig } from '@vorschicht/shared';
import { describe, expect, it } from 'vitest';
import { migrationReviewPrompt, selectMigrations } from './migration-review.js';

const config = (partial: Partial<ProjectGateConfig> = {}): ProjectGateConfig => ({
  ...EMPTY_GATE_CONFIG,
  ...partial,
});

describe('selectMigrations — was ohne Konfiguration als Migration gilt', () => {
  it.each([
    ['packages/db/migrations/0015_gates.sql', 'Drizzle-Layout'],
    ['db/migrate/20260801_add_column.rb', 'Rails-Layout'],
    ['migrations/0002_greeting.sql', 'flach im Wurzelverzeichnis'],
    ['apps/api/migration/init.ts', 'Einzahl, ohne .sql'],
    ['sql/seed.sql', 'irgendeine .sql-Datei'],
  ])('erkennt "%s" (%s)', (path) => {
    expect(selectMigrations(config(), [path])).toEqual([path]);
  });

  it.each([
    'src/greet.js',
    'README.md',
    'docs/migrations-howto.md',
    'packages/core/src/migrate-nothing.ts',
  ])('hält "%s" für keine Migration', (path) => {
    expect(selectMigrations(config(), [path])).toEqual([]);
  });

  it('gibt die Treffer in der Reihenfolge des Diffs zurück und lässt den Rest weg', () => {
    expect(
      selectMigrations(config(), [
        'src/greet.js',
        'migrations/0002.sql',
        'README.md',
        'db/migrate/0003.sql',
      ]),
    ).toEqual(['migrations/0002.sql', 'db/migrate/0003.sql']);
  });

  it('nennt eine Datei nur einmal, auch wenn zwei Muster greifen', () => {
    // `migrations/**` und `**/*.sql` treffen beide — die Auswahl filtert den
    // Diff, statt über die Muster zu iterieren, und kann deshalb nicht doppeln.
    expect(selectMigrations(config(), ['migrations/0002.sql'])).toHaveLength(1);
  });

  it('folgt der Projektkonfiguration, wenn es eine gibt, und nur ihr', () => {
    const narrow = config({ migrationPaths: ['db/schema/**'] });
    expect(selectMigrations(narrow, ['db/schema/0001.sql', 'migrations/0002.sql'])).toEqual([
      'db/schema/0001.sql',
    ]);
  });

  it('behandelt einen leeren Diff als „keine Migration"', () => {
    expect(selectMigrations(config(), [])).toEqual([]);
  });
});

describe('migrationReviewPrompt', () => {
  const input = {
    cwd: '/data/worktrees/sandbox/task-1',
    taskId: 'task-1',
    projectId: 'project-1',
    baseRef: 'main',
    migrations: ['migrations/0002_greeting.sql'],
    changedFiles: ['migrations/0002_greeting.sql', 'src/greet.js'],
    readOnlyProject: false,
  };

  it('nennt den Vergleichsbranch, damit die Sitzung den richtigen Diff liest', () => {
    const prompt = migrationReviewPrompt(input);
    expect(prompt).toContain('git merge-base main HEAD');
  });

  it('listet die Migrationen auf', () => {
    expect(migrationReviewPrompt(input)).toContain('migrations/0002_greeting.sql');
  });

  it('nennt die übrigen geänderten Dateien getrennt', () => {
    const prompt = migrationReviewPrompt(input);
    // The question "does the running release survive this" is a question about
    // the code, so the code has to be in the prompt — but listed apart, or the
    // session cannot tell what it is being asked to review.
    expect(prompt).toContain('src/greet.js');
    expect(prompt.indexOf('migrations/0002_greeting.sql')).toBeLessThan(
      prompt.indexOf('src/greet.js'),
    );
  });

  it('trennt die beiden Fragen ausdrücklich', () => {
    const prompt = migrationReviewPrompt(input);
    expect(prompt).toContain('`verdict` decides whether this may merge');
    expect(prompt).toContain('does\n    not block the merge');
  });

  it('kürzt eine sehr lange Dateiliste und sagt, dass gekürzt wurde', () => {
    const many = Array.from({ length: 80 }, (_, index) => `src/file-${index}.js`);
    const prompt = migrationReviewPrompt({
      ...input,
      changedFiles: [...input.migrations, ...many],
    });
    expect(prompt).toContain('… and 20 more');
  });

  it('lässt den Abschnitt weg, wenn der Kandidat nur Migrationen ändert', () => {
    const prompt = migrationReviewPrompt({ ...input, changedFiles: [...input.migrations] });
    expect(prompt).not.toContain('Other files this change touches');
  });
});
