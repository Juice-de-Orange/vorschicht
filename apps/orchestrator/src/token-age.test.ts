import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assessTokenAge,
  readTokenInstall,
  recordTokenInstall,
  TOKEN_CRITICAL_DAYS,
  TOKEN_LIFETIME_MS,
  TOKEN_WARN_DAYS,
} from './token-age.js';

const DAY = 24 * 60 * 60_000;
const INSTALLED = Date.parse('2026-01-01T00:00:00Z');
const scratch = mkdtempSync(join(tmpdir(), 'vorschicht-token-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('assessTokenAge', () => {
  const at = (daysRemaining: number) => INSTALLED + TOKEN_LIFETIME_MS - daysRemaining * DAY;

  it('meldet nichts, solange reichlich Zeit bleibt', () => {
    const age = assessTokenAge(INSTALLED, at(200));
    expect(age.urgency).toBe('ok');
    expect(age.message).toBeNull();
  });

  it.each([
    [TOKEN_WARN_DAYS, 'warn'],
    [TOKEN_CRITICAL_DAYS, 'critical'],
    [1, 'critical'],
  ])('bei %i Tagen Restlaufzeit: %s', (days, urgency) => {
    const age = assessTokenAge(INSTALLED, at(days));
    expect(age.urgency).toBe(urgency);
    expect(age.daysRemaining).toBe(days);
    // §2: user-facing text is German, and it names the way out.
    expect(age.message).toContain('Token');
  });

  it('nennt beim kritischen Stand das Kommando, das hilft', () => {
    expect(assessTokenAge(INSTALLED, at(3)).message).toContain('setup-token');
  });

  it('behandelt einen abgelaufenen Token als kritisch, nicht als unbekannt', () => {
    const age = assessTokenAge(INSTALLED, at(-5));
    expect(age.urgency).toBe('critical');
    expect(age.daysRemaining).toBeLessThan(0);
  });

  // `claude auth status` carries no expiry date — verified. Without a recorded
  // install date the remaining lifetime is genuinely unknown, and reporting
  // "ok" there would be a guess dressed as a fact.
  it('gibt "unbekannt" zurück, statt Sicherheit vorzutäuschen', () => {
    const age = assessTokenAge(null, Date.now());
    expect(age.urgency).toBe('unknown');
    expect(age.daysRemaining).toBeNull();
    expect(age.message).toContain('kein Installationsdatum');
  });
});

describe('Buchführung auf der Platte', () => {
  it('schreibt und liest das Installationsdatum', () => {
    const path = join(scratch, 'nested', 'token.json');
    recordTokenInstall(path, INSTALLED);
    expect(readTokenInstall(path)).toBe(INSTALLED);
  });

  it('liefert null bei fehlender oder kaputter Datei', () => {
    expect(readTokenInstall(join(scratch, 'gibt-es-nicht.json'))).toBeNull();
  });
});
