/**
 * Database client construction.
 *
 * The connection itself lives in `sql.ts` and is re-exported here, so that a
 * process needing only a connection can import `@vorschicht/db/sql` and skip
 * Drizzle entirely — see that file for why ~900 ms of import time is worth a
 * subpath export. Everything that needs the typed query builder keeps importing
 * this module and nothing changes for it.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';
import { createSql, type DatabaseOptions } from './sql.js';

export { createSql, type DatabaseOptions } from './sql.js';

export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(options: DatabaseOptions) {
  const sql = createSql(options);
  return { sql, db: drizzle(sql, { schema }) };
}
