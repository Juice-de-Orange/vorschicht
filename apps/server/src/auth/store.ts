/**
 * Persistence for the passkey flow (§19).
 *
 * Every function here takes the raw token and hashes internally, so a caller
 * cannot accidentally persist one. Nothing in this module returns a token
 * either — minting is the single exception, and it hands the plaintext back
 * exactly once.
 */
import type { InviteFacts, RegistrationPurpose } from '@vorschicht/shared';
import type postgres from 'postgres';
import { CHALLENGE_TTL_MS, hashToken, INVITE_TTL_MS, mintToken, SESSION_TTL_MS } from './tokens.js';

export interface StoredCredential {
  id: string;
  credentialId: string;
  publicKey: Uint8Array;
  counter: bigint;
  transports: string[];
  label: string;
}

export interface SessionFacts {
  sessionId: string;
  credentialId: string;
}

export class AuthStore {
  constructor(private readonly sql: postgres.Sql) {}

  // --- credentials -----------------------------------------------------------

  async countCredentials(): Promise<number> {
    const [row] = await this.sql<{ count: string }[]>`SELECT count(*)::text FROM credentials`;
    return Number(row?.count ?? 0);
  }

  async listCredentials(): Promise<
    Array<{ id: string; label: string; createdAt: Date; lastUsedAt: Date | null }>
  > {
    return this.sql`
      SELECT id, label, created_at AS "createdAt", last_used_at AS "lastUsedAt"
      FROM credentials ORDER BY created_at
    ` as unknown as Promise<
      Array<{ id: string; label: string; createdAt: Date; lastUsedAt: Date | null }>
    >;
  }

  async findCredential(credentialId: string): Promise<StoredCredential | null> {
    const [row] = await this.sql<
      Array<{
        id: string;
        credential_id: string;
        public_key: Uint8Array;
        counter: string;
        transports: string[];
        label: string;
      }>
    >`
      SELECT id, credential_id, public_key, counter::text, transports, label
      FROM credentials WHERE credential_id = ${credentialId}
    `;
    if (!row) return null;
    return {
      id: row.id,
      credentialId: row.credential_id,
      publicKey: row.public_key,
      counter: BigInt(row.counter),
      transports: row.transports,
      label: row.label,
    };
  }

  async saveCredential(input: {
    credentialId: string;
    publicKey: Uint8Array;
    counter: number;
    transports: string[];
    backedUp: boolean;
    label: string;
  }): Promise<string> {
    const [row] = await this.sql<{ id: string }[]>`
      INSERT INTO credentials (credential_id, public_key, counter, transports, backed_up, label)
      VALUES (${input.credentialId}, ${input.publicKey}, ${input.counter},
              ${input.transports}, ${input.backedUp}, ${input.label})
      RETURNING id
    `;
    if (!row) throw new Error('Credential konnte nicht gespeichert werden');
    return row.id;
  }

  /**
   * Persist the new signature counter.
   *
   * A counter that fails to increase can indicate a cloned authenticator, so
   * the caller checks first; this method only records the accepted value.
   */
  async touchCredential(id: string, counter: number): Promise<void> {
    await this.sql`
      UPDATE credentials SET counter = ${counter}, last_used_at = now() WHERE id = ${id}
    `;
  }

  // --- invites ---------------------------------------------------------------

  /** Mints an invite and returns the plaintext token — the only time it exists. */
  async createInvite(purpose: RegistrationPurpose, ttlMs = INVITE_TTL_MS): Promise<string> {
    const token = mintToken();
    await this.sql`
      INSERT INTO invites (token_hash, purpose, expires_at)
      VALUES (${hashToken(token)}, ${purpose}, now() + ${`${Math.round(ttlMs / 1000)} seconds`}::interval)
    `;
    return token;
  }

  async findInvite(token: string): Promise<(InviteFacts & { id: string }) | null> {
    const [row] = await this.sql<
      Array<{ id: string; purpose: RegistrationPurpose; expires_at: Date; used_at: Date | null }>
    >`
      SELECT id, purpose, expires_at, used_at FROM invites WHERE token_hash = ${hashToken(token)}
    `;
    if (!row) return null;
    return {
      id: row.id,
      purpose: row.purpose,
      expiresAt: row.expires_at.getTime(),
      usedAt: row.used_at?.getTime() ?? null,
    };
  }

  /**
   * Consume an invite, but only if it is still unused.
   *
   * The `used_at IS NULL` predicate is what makes "single-use" true under
   * concurrency: two simultaneous registrations with the same invite race here,
   * and exactly one row is updated.
   */
  async consumeInvite(id: string, credentialId: string): Promise<boolean> {
    const rows = await this.sql`
      UPDATE invites SET used_at = now(), used_by = ${credentialId}
      WHERE id = ${id} AND used_at IS NULL
      RETURNING id
    `;
    return rows.length === 1;
  }

  // --- challenges ------------------------------------------------------------

  async saveChallenge(challenge: string, kind: 'registration' | 'authentication'): Promise<void> {
    await this.sql`
      INSERT INTO auth_challenges (challenge, kind, expires_at)
      VALUES (${challenge}, ${kind}, now() + ${`${Math.round(CHALLENGE_TTL_MS / 1000)} seconds`}::interval)
    `;
  }

  /** Consumes a challenge; returns false if unknown, expired or already used. */
  async consumeChallenge(
    challenge: string,
    kind: 'registration' | 'authentication',
  ): Promise<boolean> {
    const rows = await this.sql`
      UPDATE auth_challenges SET consumed_at = now()
      WHERE challenge = ${challenge} AND kind = ${kind}
        AND consumed_at IS NULL AND expires_at > now()
      RETURNING id
    `;
    return rows.length === 1;
  }

  async pruneExpired(): Promise<void> {
    await this.sql`DELETE FROM auth_challenges WHERE expires_at < now() - interval '1 day'`;
    await this.sql`DELETE FROM invites WHERE expires_at < now() - interval '30 days'`;
  }

  // --- sessions --------------------------------------------------------------

  async createSession(
    credentialId: string,
    context: { userAgent?: string | null; ip?: string | null } = {},
  ): Promise<string> {
    const token = mintToken();
    await this.sql`
      INSERT INTO sessions (token_hash, credential_id, expires_at, user_agent, ip)
      VALUES (${hashToken(token)}, ${credentialId},
              now() + ${`${Math.round(SESSION_TTL_MS / 1000)} seconds`}::interval,
              ${context.userAgent ?? null}, ${context.ip ?? null})
    `;
    return token;
  }

  async findSession(token: string): Promise<SessionFacts | null> {
    const [row] = await this.sql<Array<{ id: string; credential_id: string }>>`
      UPDATE sessions SET last_seen_at = now()
      WHERE token_hash = ${hashToken(token)} AND revoked_at IS NULL AND expires_at > now()
      RETURNING id, credential_id
    `;
    if (!row) return null;
    return { sessionId: row.id, credentialId: row.credential_id };
  }

  async revokeSession(token: string): Promise<void> {
    await this.sql`
      UPDATE sessions SET revoked_at = now()
      WHERE token_hash = ${hashToken(token)} AND revoked_at IS NULL
    `;
  }

  // --- audit -----------------------------------------------------------------

  async logAuthEvent(entry: {
    kind: string;
    outcome: 'ok' | 'refused' | 'error';
    detail?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<void> {
    await this.sql`
      INSERT INTO auth_events (kind, outcome, detail, ip, user_agent)
      VALUES (${entry.kind}, ${entry.outcome}, ${entry.detail ?? null},
              ${entry.ip ?? null}, ${entry.userAgent ?? null})
    `;
  }
}
