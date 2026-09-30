import type postgres from 'postgres';

/**
 * Anything a query can be run against — the pool, or a transaction.
 *
 * `postgres.TransactionSql` does **not** extend `postgres.Sql` (it has no
 * `begin`, no `end`, no `listen`), so a service typed against the pool cannot
 * be handed the transaction from `sql.begin()`. That matters wherever a
 * read-then-write has to be one atomic act: claim acquisition (§10) checks for
 * conflicts and then writes the state change, and the two happening in separate
 * connections is precisely the race the check exists to prevent.
 *
 * Widening to the common ancestor is the honest fix. The alternative — casting
 * a transaction to a pool — type-checks and then lies about what the value can
 * do.
 */
export type Queryable = postgres.ISql;
