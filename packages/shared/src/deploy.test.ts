import { describe, expect, it } from 'vitest';
import { deployMethodSchema } from './agent-result.js';
import {
  DEFAULT_HEALTH_INTERVAL_MS,
  DEFAULT_HEALTH_TIMEOUT_MS,
  DEFAULT_KEEP_RELEASES,
  DEPLOY_METHOD_LABELS,
  deployConfigSchema,
  endsAtMerge,
  NO_DEPLOY,
  readDeployConfig,
  validateDeployConfig,
} from './deploy.js';

/**
 * §12 hands this document the authority to replace what is running, so what is
 * asserted here is mostly what it **refuses**.
 */

const compose = {
  method: 'compose' as const,
  composeFiles: ['docker-compose.yml'],
  service: 'app',
  healthUrl: 'https://example.test/healthz',
};

const statisch = {
  method: 'static-rsync' as const,
  buildCommand: 'npm run build',
  distDir: 'dist',
  target: 'host:/srv/site',
  healthUrl: 'https://example.test/',
};

describe('die Deploy-Konfiguration (§12, A11, A24)', () => {
  it('nimmt „kein Deployment" als vollständige Antwort', () => {
    // A24: ein grüner Merge ist hier der Schluss, nicht ein halber Zustand.
    expect(deployConfigSchema.parse({ method: 'none' })).toEqual({ method: 'none' });
    expect(endsAtMerge(NO_DEPLOY)).toBe(true);
    expect(endsAtMerge(deployConfigSchema.parse(compose))).toBe(false);
  });

  it('setzt die Vorgaben, über die ein Projekt nie nachgedacht hat', () => {
    const gelesen = deployConfigSchema.parse(compose);
    if (gelesen.method !== 'compose') throw new Error('compose erwartet');
    expect(gelesen.healthTimeoutMs).toBe(DEFAULT_HEALTH_TIMEOUT_MS);
    expect(gelesen.healthIntervalMs).toBe(DEFAULT_HEALTH_INTERVAL_MS);
    expect(gelesen.keep).toBe(DEFAULT_KEEP_RELEASES);
  });

  it('verlangt je Methode genau ihre eigenen Felder', () => {
    // Der ganze Grund für die diskriminierte Union: eine Form mit lauter
    // optionalen Feldern ließe ein halb ausgefülltes Dokument durch und
    // scheiterte erst in dem Moment, in dem es die Produktion tauscht.
    // `method` **nach** dem Spread, sonst gewinnt das gespreizte und das
    // Dokument ist schlicht ein gültiges static-rsync. Der erste Anlauf hatte
    // genau diesen Fehler, und der Test hat ihn gemeldet.
    expect(deployConfigSchema.safeParse({ ...statisch, method: 'compose' }).success).toBe(false);
    expect(
      deployConfigSchema.safeParse({ method: 'compose', healthUrl: compose.healthUrl }).success,
    ).toBe(false);
    expect(deployConfigSchema.safeParse({ ...statisch, distDir: '' }).success).toBe(false);
  });

  it('verweigert eine Gesundheitsprüfung ohne Grenze', () => {
    // Ohne Zeitgrenze wartet ein Deploy ewig auf einen Dienst, der nie
    // hochkommt — und in der Zwischenzeit darf nichts anderes anfangen.
    expect(deployConfigSchema.safeParse({ ...compose, healthTimeoutMs: 0 }).success).toBe(false);
    expect(deployConfigSchema.safeParse({ ...compose, healthUrl: 'kein-url' }).success).toBe(false);
  });

  it('verweigert ein Shell-Sonderzeichen im Befehl und sagt, in welchem', () => {
    const ergebnis = validateDeployConfig({
      ...compose,
      migrateCommand: 'pnpm db:migrate && rm -rf /',
    });
    expect(ergebnis.ok).toBe(false);
    // Die Meldung zitiert den Befehl, statt „ungültig" zu sagen — sonst sucht
    // jemand danach.
    expect(ergebnis.errors.join(' ')).toContain('pnpm db:migrate && rm -rf /');
    expect(ergebnis.errors.join(' ')).toContain('Shell-Sonderzeichen');
  });

  it('lässt keine Aufbewahrung zu, die einen Rollback unmöglich macht', () => {
    // Eins zum Ausliefern und eins zum Zurückfallen ist das Minimum, das §12s
    // Rollback überhaupt möglich macht; null löschte das laufende Release.
    expect(deployConfigSchema.safeParse({ ...compose, keep: 1 }).success).toBe(false);
    expect(deployConfigSchema.safeParse({ ...compose, keep: 2 }).success).toBe(true);
  });

  it('macht aus einem unlesbaren Dokument „kein Deployment", nicht „irgendwas"', () => {
    // Die sichere Richtung: „wir konnten es nicht lesen" muss „nichts
    // ausrollen" heißen und niemals „mit dem ausrollen, was durchs Parsen kam".
    expect(readDeployConfig({ method: 'compose' })).toEqual(NO_DEPLOY);
    expect(readDeployConfig(null)).toEqual(NO_DEPLOY);
    expect(readDeployConfig({ method: 'erfunden' })).toEqual(NO_DEPLOY);
    expect(readDeployConfig(compose).method).toBe('compose');
  });

  it('kennt für jede Methode einen deutschen Namen — und nur für die', () => {
    // Keine zweite Liste: die Methoden sind `agent-result.ts`s. Kommt eine
    // vierte dazu, bricht diese Zusicherung, statt `undefined` zu rendern.
    expect(Object.keys(DEPLOY_METHOD_LABELS).sort()).toEqual(
      [...deployMethodSchema.options].sort(),
    );
    for (const label of Object.values(DEPLOY_METHOD_LABELS))
      expect(label.length).toBeGreaterThan(0);
  });
});
