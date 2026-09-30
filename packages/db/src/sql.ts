/**
 * The bare Postgres connection, with nothing else attached.
 *
 * Split out of `client.ts` for one measured reason: `client.ts` imports Drizzle
 * and the schema, and that import costs roughly 900 ms. The MCP server (§6.2)
 * is spawned by the CLI *per session* and races the CLI's own startup — a
 * server that has not completed its handshake by `system:init` leaves the
 * agent's first turn with none of its tools, and the model reports that it can
 * do nothing and stops. Nine hundred milliseconds is a large share of that
 * race, and the server never touches Drizzle: it writes through the services,
 * which use tagged SQL.
 *
 * So `@vorschicht/db/sql` exists as a subpath export for processes that need a
 * connection and nothing else. `client.ts` re-exports it, so every existing
 * caller is unaffected and there is still exactly one place where connection
 * semantics are decided.
 *
 * One deliberate choice lives here: the runtime connects as `vorschicht_app`,
 * not as the owner. The append-only guard triggers bind everyone, but running
 * the application under a role with no UPDATE/DELETE grant on the event tables
 * means the intent is also visible in `information_schema` — where someone
 * auditing this system will actually look.
 */
import postgres from 'postgres';

export interface DatabaseOptions {
  url: string;
  /** Connection pool size. Keep at 1 for migration and CLI use. */
  max?: number;
  /** Emit Postgres notices (RAISE NOTICE) to the logger instead of stderr. */
  onNotice?: (notice: unknown) => void;
}

export function createSql(options: DatabaseOptions): postgres.Sql {
  return postgres(options.url, {
    max: options.max ?? 10,
    onnotice: options.onNotice ?? (() => {}),
    // Timestamps stay as Date objects; everything in this system is
    // Europe/Vienna at the presentation layer only (§2).
    transform: { undefined: null },
  });
}
