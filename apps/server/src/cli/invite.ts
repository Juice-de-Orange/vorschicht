/**
 * `vorschicht-invite` — mint a one-time registration invite (§19).
 *
 * This is the rescue path. It runs on the host, over SSH, and is the only way
 * to register a passkey without already holding a session — which is precisely
 * why it lives here and not behind an HTTP endpoint: whoever can run it already
 * has shell access to the production host, and no passkey outranks that.
 *
 *   docker compose -f infra/docker-compose.yml --env-file .env \
 *     exec app node dist/cli/invite.js [--purpose=rescue]
 *
 * In the `app` service: this file is built into that image and into no other.
 * There is no `vorschicht-invite` binary on the host — the name is this
 * module's, not a command.
 *
 * The token is printed exactly once. It is stored only as a hash, so a lost
 * token cannot be recovered — mint a new one.
 */
import { loadConfig } from '@vorschicht/core';
import { createSql } from '@vorschicht/db';
import { bootstrapState, type RegistrationPurpose } from '@vorschicht/shared';
import { AuthStore } from '../auth/store.js';
import { INVITE_TTL_MS } from '../auth/tokens.js';

const PURPOSES: RegistrationPurpose[] = ['bootstrap', 'rescue', 'additional'];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const purposeArg = args.find((a) => a.startsWith('--purpose='))?.split('=')[1];
  const purpose = (purposeArg ?? 'bootstrap') as RegistrationPurpose;

  if (!PURPOSES.includes(purpose)) {
    console.error(`Unbekannter Zweck "${purpose}". Erlaubt: ${PURPOSES.join(', ')}`);
    process.exit(2);
  }

  const config = loadConfig();
  const sql = createSql({ url: config.databaseUrl, max: 1 });
  const store = new AuthStore(sql);

  try {
    const state = bootstrapState(await store.countCredentials());
    const token = await store.createInvite(purpose, INVITE_TTL_MS);
    const url = `${config.publicOrigin.replace(/\/+$/, '')}/registrieren#${token}`;
    const minutes = Math.round(INVITE_TTL_MS / 60_000);

    console.log('');
    console.log('  Einladung erzeugt — gilt einmalig und nur %d Minuten:', minutes);
    console.log('');
    console.log('    %s', url);
    console.log('');
    console.log('  Zweck:    %s', purpose);
    console.log(
      '  Passkeys: %d hinterlegt%s',
      state.credentialCount,
      state.complete ? '' : ` — noch ${state.missing} bis zur vollständigen Einrichtung`,
    );
    console.log('');
    // The fragment keeps the token out of server logs and out of the Referer
    // header: everything after # never leaves the browser.
    console.log('  Der Token steht hinter dem #, wird also nie an den Server übertragen');
    console.log('  und taucht in keinem Zugriffslog auf.');
    console.log('');
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
