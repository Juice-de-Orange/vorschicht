import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BOT_IDENTITY, resolveBotIdentity } from './git.js';

/**
 * Who the studio's commits are authored by (A20/A36).
 *
 * The identity was a literal in `git.ts` and in both Dockerfiles, while
 * `.env.example` documented `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` that nothing
 * read. An operator who set them got commits by a placeholder address anyway.
 */
describe('Bot-Identität (A20/A36)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('nimmt GIT_AUTHOR_NAME und GIT_AUTHOR_EMAIL', () => {
    expect(
      resolveBotIdentity({
        GIT_AUTHOR_NAME: 'Studio Bot',
        GIT_AUTHOR_EMAIL: 'bot@example.org',
      }),
    ).toEqual({ name: 'Studio Bot', email: 'bot@example.org' });
  });

  it('fällt ohne oder mit leeren Variablen auf die neutrale Vorgabe zurück', () => {
    expect(resolveBotIdentity({})).toEqual(DEFAULT_BOT_IDENTITY);
    expect(resolveBotIdentity({ GIT_AUTHOR_NAME: ' ', GIT_AUTHOR_EMAIL: '' })).toEqual(
      DEFAULT_BOT_IDENTITY,
    );
    expect(DEFAULT_BOT_IDENTITY).toEqual({
      name: 'Vorschicht Bot',
      email: 'vorschicht-bot@example.com',
    });
  });

  it('nimmt jede Hälfte einzeln — ein Name ohne Adresse behält die Vorgabe-Adresse', () => {
    expect(resolveBotIdentity({ GIT_AUTHOR_NAME: 'Studio Bot' })).toEqual({
      name: 'Studio Bot',
      email: DEFAULT_BOT_IDENTITY.email,
    });
  });

  it('BOT_IDENTITY folgt der Umgebung des Prozesses', async () => {
    vi.stubEnv('GIT_AUTHOR_NAME', 'Studio Bot');
    vi.stubEnv('GIT_AUTHOR_EMAIL', 'bot@example.org');
    vi.resetModules();
    const { BOT_IDENTITY } = await import('./git.js');
    expect(BOT_IDENTITY).toEqual({
      name: 'Studio Bot',
      email: 'bot@example.org',
    });
  });
});
