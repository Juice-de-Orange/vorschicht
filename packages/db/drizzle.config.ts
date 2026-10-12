/**
 * drizzle-kit's view of this package (`pnpm db:generate`).
 *
 * The SQL files in `migrations/` are authoritative and hand-written (roles,
 * grants and guard triggers no generator produces — see `schema.ts`). The
 * generator is a *draft* tool for the part `schema.ts` mirrors: after a change
 * to the mirror, `pnpm db:generate --name <what>` writes the next numbered file
 * (`migrations/00NN_<what>.sql`, plain SQL without statement breakpoints, as
 * the hand-rolled runner in `src/migrate.ts` reads it) plus a snapshot in
 * `migrations/meta/`. Review it, add what the generator cannot know, keep the
 * snapshot. On a tree whose mirror matches the newest snapshot it answers
 * "No schema changes".
 *
 * `migrations/meta/` holds one baseline: the journal entry for the newest
 * hand-written migration and the snapshot of `schema.ts` at that point. Its
 * index is that file's number, so the next generated file gets the next one.
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  breakpoints: false,
  migrations: { prefix: 'index' },
});
