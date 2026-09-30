import { describe, expect, it } from 'vitest';
import { ConfigError, FORBIDDEN_ENV_KEYS, loadConfig, redact } from './config.js';

const VALID: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://vorschicht:pw@127.0.0.1:5436/vorschicht',
  PUBLIC_ORIGIN: 'https://vorschicht.example.com',
  WEBAUTHN_RP_ID: 'vorschicht.example.com',
  SESSION_SECRET: 'x'.repeat(48),
  CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-${'y'.repeat(40)}`,
  CLAUDE_CLI_VERSION: '2.1.220',
  NTFY_SERVER: 'https://ntfy.example.com',
  NTFY_TOKEN: 'tk_example',
};

describe('loadConfig', () => {
  it('accepts a complete environment and applies the documented defaults', () => {
    const config = loadConfig(VALID);
    expect(config.appPort).toBe(8420);
    expect(config.appBind).toBe('127.0.0.1');
    expect(config.projectsRoot).toBe('/opt');
    expect(config.planProfile).toBe('max_20x');
  });

  // §2 is a hard rule, not a preference. The presence of an API key means
  // someone arranged for money to be spendable — fail at that moment, loudly,
  // rather than discovering it on a bill.
  it.each(FORBIDDEN_ENV_KEYS)('refuses to start when %s is set', (key) => {
    expect(() => loadConfig({ ...VALID, [key]: 'sk-ant-api03-whatever' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...VALID, [key]: 'sk-ant-api03-whatever' })).toThrow(/§2/);
  });

  it('ignores a forbidden key that is present but empty', () => {
    expect(() => loadConfig({ ...VALID, ANTHROPIC_API_KEY: '' })).not.toThrow();
  });

  it('rejects an API key handed in as the Claude token', () => {
    expect(() =>
      loadConfig({ ...VALID, CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-api03-${'z'.repeat(40)}` }),
    ).toThrow(/Abo-Token/);
  });

  it('rejects a session secret that is too short to be worth having', () => {
    expect(() => loadConfig({ ...VALID, SESSION_SECRET: 'short' })).toThrow(ConfigError);
  });

  it('collects every problem instead of stopping at the first', () => {
    try {
      loadConfig({ NTFY_SERVER: 'not-a-url' });
      expect.unreachable('loadConfig hätte werfen müssen');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems.length).toBeGreaterThan(3);
    }
  });
});

/**
 * An emptied line is how this block says "not configured", and every other
 * variable in it accepts that: `.env.example` ships `SMTP_USER=`,
 * `SMTP_PASSWORD=` and `REPORT_RECIPIENT=` blank. `SMTP_PORT` and `SMTP_SECURE`
 * ship with values — so the example file does not trigger this itself, and what
 * does is anyone clearing one of them, or a deploy template that renders an
 * unset variable as `SMTP_PORT=`.
 *
 * The third case is what keeps the first from becoming "blank means the default,
 * and so does anything else": a variable set to nonsense is a configuration
 * error and must still stop the boot, because the operator who typed it is the
 * only one who can say what they meant.
 */
describe('loadConfig — SMTP', () => {
  it('reads a blank variable as unset and applies the documented default', () => {
    const config = loadConfig({
      ...VALID,
      SMTP_HOST: '',
      SMTP_PORT: '',
      SMTP_SECURE: '',
      SMTP_FROM: '  ',
    });
    expect(config.smtpPort).toBe(465);
    expect(config.smtpSecure).toBe(true);
    expect(config.smtpHost).toBeUndefined();
    expect(config.smtpFrom).toBeUndefined();
  });

  it('takes a configured port and a configured STARTTLS setting', () => {
    const config = loadConfig({ ...VALID, SMTP_PORT: '587', SMTP_SECURE: 'false' });
    expect(config.smtpPort).toBe(587);
    expect(config.smtpSecure).toBe(false);
  });

  it('still refuses a value that is set and wrong', () => {
    expect(() => loadConfig({ ...VALID, SMTP_PORT: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...VALID, SMTP_SECURE: 'vielleicht' })).toThrow(ConfigError);
  });
});

describe('redact', () => {
  it('hides every secret and keeps everything else readable', () => {
    // The mailbox password is loaded here rather than in `VALID`, because an
    // optional variable that was never set is absent from the parsed config and
    // a `«redacted»` assertion over an absent key proves nothing.
    const safe = redact(loadConfig({ ...VALID, SMTP_PASSWORD: 'geheim' }));
    expect(safe.claudeOauthToken).toBe('«redacted»');
    expect(safe.sessionSecret).toBe('«redacted»');
    expect(safe.ntfyToken).toBe('«redacted»');
    expect(safe.databaseUrl).toBe('«redacted»');
    expect(safe.smtpPassword).toBe('«redacted»');
    expect(safe.appPort).toBe(8420);
    expect(JSON.stringify(safe)).not.toContain('sk-ant-oat');
    expect(JSON.stringify(safe)).not.toContain('geheim');
  });
});

describe('Radar-Kanäle (§6.0, A27, A10)', () => {
  it('lässt beide Anthropic-Kanäle unkonfiguriert, statt eine URL zu erfinden', () => {
    // The default state is "nothing is watched", and the radar says so on every
    // run. A guessed URL would 404 every six hours and read as "nothing
    // announced" — for the project's own #1 external risk.
    const config = loadConfig(VALID);
    expect(config.radarBillingUrls).toEqual([]);
    expect(config.radarCliUrl).toBeNull();
    // The registry is the one channel whose shape this project can name.
    expect(config.radarRegistry).toBe('https://registry.npmjs.org');
  });

  it('zerlegt die Abrechnungskanäle an Kommas und wirft Leeres weg', () => {
    expect(
      loadConfig({
        ...VALID,
        VORSCHICHT_RADAR_BILLING_URLS: ' https://a.test/x , ,https://b.test/y ',
      }).radarBillingUrls,
    ).toEqual(['https://a.test/x', 'https://b.test/y']);
  });

  it('nimmt eine geleerte Zeile als «nicht gesetzt» (A82.1)', () => {
    // `.default()` fires on `undefined` and on nothing else, so without
    // `blankToUndefined` an emptied `VORSCHICHT_RADAR_CLI_URL` would refuse to
    // boot — which is how an empty line once stopped the daemon starting.
    const config = loadConfig({
      ...VALID,
      VORSCHICHT_RADAR_CLI_URL: '',
      VORSCHICHT_RADAR_BILLING_URLS: '',
      VORSCHICHT_RADAR_REGISTRY: '',
    });
    expect(config.radarCliUrl).toBeNull();
    expect(config.radarBillingUrls).toEqual([]);
    expect(config.radarRegistry).toBe('https://registry.npmjs.org');
  });

  it('hält einen gesetzten, aber unbrauchbaren Kanal weiterhin an', () => {
    // A82.1's third case: blank means the default, and garbage still stops the
    // boot — the operator who typed it is the only one who can say what they
    // meant.
    expect(() => loadConfig({ ...VALID, VORSCHICHT_RADAR_CLI_URL: 'kein-url' })).toThrow(
      ConfigError,
    );
  });
});
