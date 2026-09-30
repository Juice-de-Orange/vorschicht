import { describe, expect, it } from 'vitest';
import { EXCLUDE_CREDENTIALS_MAX, neuesteZuerst } from './routes.js';

/**
 * §19s Registrierung: der Deckel auf `excludeCredentials`.
 *
 * Der Browser weist die **ganze** Zeremonie ab, wenn die Liste seine Grenze
 * überschreitet — gemessen am 24.8.2026 in der Browserstrecke: „The
 * `excludeCredentials` attribute exceeds the maximum allowed size (64)". Ein
 * Konto darüber könnte keinen Passkey mehr registrieren, auch nicht über §19s
 * Rettungspfad, und dort wird er gebraucht.
 */

const cred = (id: string, iso: string) => ({ id, createdAt: new Date(iso) });

describe('excludeCredentials wird gedeckelt', () => {
  it('bleibt unter der Grenze, die der Browser durchsetzt', () => {
    // Nicht 64, sondern mit Luft: eine strengere Fassung darf die Zeremonie
    // nicht kippen, und niemand braucht 32 Geräte (§19 verlangt zwei).
    expect(EXCLUDE_CREDENTIALS_MAX).toBeLessThan(64);
    expect(EXCLUDE_CREDENTIALS_MAX).toBeGreaterThanOrEqual(8);
  });

  it('behält die neuesten, nicht die ältesten', () => {
    const rows = [
      cred('alt', '2020-01-01T00:00:00Z'),
      cred('mittel', '2024-01-01T00:00:00Z'),
      cred('neu', '2026-01-01T00:00:00Z'),
    ];
    // Der Zweck von `excludeCredentials` ist, ein Gerät nicht zweimal zu
    // registrieren. Wer heute ein Gerät in der Hand hat, hat es zuletzt
    // registriert — die andere Richtung schnitte genau die weg, die zählen.
    expect(neuesteZuerst(rows).map((r) => r.id)).toEqual(['neu', 'mittel', 'alt']);
  });

  it('lässt die übergebene Liste unverändert', () => {
    // `listCredentials` sortiert aufsteigend, weil die Einrichtungszählung sie
    // so liest; ein `reverse()` an dieser Stelle würde jene Leserin still
    // verändern. Die Zusicherung ist billig und fängt genau diesen Rückfall.
    const rows = [cred('a', '2020-01-01T00:00:00Z'), cred('b', '2026-01-01T00:00:00Z')];
    neuesteZuerst(rows);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('schneidet eine überlange Liste wirklich ab', () => {
    const viele = Array.from({ length: 100 }, (_, i) =>
      cred(`c${i}`, new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString()),
    );
    const gesendet = neuesteZuerst(viele).slice(0, EXCLUDE_CREDENTIALS_MAX);
    expect(gesendet).toHaveLength(EXCLUDE_CREDENTIALS_MAX);
    // Und es sind die jüngsten: `c99` ist der neueste Eintrag.
    expect(gesendet[0]?.id).toBe('c99');
  });
});
