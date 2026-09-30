import { createSql, migrate } from '@vorschicht/db';

/**
 * Prepare the throwaway database before the E2E servers start.
 *
 * In production the orchestrator owns migrations and applies them at boot; the
 * E2E suite deliberately does not run the orchestrator (it would want a real
 * Claude CLI and a real token), so the schema is applied here instead. Same
 * migration files, same runner — only the trigger differs.
 */
export default async function globalSetup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL fehlt — die E2E-Suite über infra/scripts/with-test-db.sh starten.',
    );
  }

  const sql = createSql({ url, max: 1 });
  try {
    const { applied } = await migrate(sql);
    console.log(`e2e: Schema bereit (${applied.length} Migration(en) angewendet)`);
  } finally {
    await sql.end();
  }
}
