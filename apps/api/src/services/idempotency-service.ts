import type { Pool, PoolClient } from 'pg';
import { canonicalJsonStringify } from '@crewmesh/shared';
import { getDbPool, withTransaction } from '../db/pool.js';
import { AppError } from '../plugins/error-handler.js';
import { sha256Hex } from '../security/crypto.js';

export interface IdempotentExecutionResult<T> {
  statusCode: number;
  body: T;
  replayed: boolean;
}

interface IdempotencyRow {
  id: string;
  request_hash: string;
  status: 'in_progress' | 'completed';
  response_status: number | null;
  response_body: unknown;
  completed_at: Date | null;
  expires_at: Date;
}

/**
 * Extracts and validates the required `Idempotency-Key` HTTP header.
 */
export function requireIdempotencyKeyHeader(
  rawHeader: string | string[] | undefined,
): string {
  const value = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (!value || typeof value !== 'string') {
    throw new AppError(
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'An Idempotency-Key header (8–128 characters) is required for this mutating operation',
    );
  }
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 128 || !/^[\x21-\x7E]+$/.test(trimmed)) {
    throw new AppError(
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'Idempotency-Key must be between 8 and 128 printable ASCII characters',
    );
  }
  return trimmed;
}

/**
 * Computes a canonical SHA-256 hex digest of the operation's parameters and payload.
 */
export function computeCanonicalRequestHash(payload: unknown): string {
  return sha256Hex(canonicalJsonStringify(payload));
}

/**
 * Executes a state-changing operation transactionally with PostgreSQL-backed idempotency.
 *
 * Concurrency guarantee:
 * `INSERT INTO idempotency_keys ... ON CONFLICT (actor_user_id, operation, idempotency_key) DO UPDATE`
 * acquires a row-level lock on the idempotency record in PostgreSQL.
 * If two identical requests arrive simultaneously:
 * - Transaction 1 acquires the lock, executes the mutation, writes the completed response, and commits.
 * - Transaction 2 blocks on the row lock until Transaction 1 commits, then reads the committed
 *   `status = 'completed'` row and replays the stored HTTP status and body without re-running the mutation.
 * - If the same key is reused with a different canonical request hash, throws 409 IDEMPOTENCY_KEY_REUSED.
 */
export async function executeIdempotentMutation<T>(
  params: {
    actorUserId: string;
    operation: string;
    idempotencyKey: string;
    requestPayload: unknown;
    pool?: Pool;
  },
  handler: (client: PoolClient) => Promise<{ statusCode: number; body: T }>,
): Promise<IdempotentExecutionResult<T>> {
  const pool = params.pool ?? getDbPool();
  const requestHash = computeCanonicalRequestHash(params.requestPayload);

  return withTransaction(async (client) => {
    // Purge expired idempotency key if the exact same actor/operation/key expired (>24h old)
    await client.query(
      `
      DELETE FROM idempotency_keys
      WHERE actor_user_id = $1
        AND operation = $2
        AND idempotency_key = $3
        AND expires_at <= NOW()
      `,
      [params.actorUserId, params.operation, params.idempotencyKey],
    );

    // Claim or lock the idempotency key row
    const claimRes = await client.query<IdempotencyRow>(
      `
      INSERT INTO idempotency_keys (
        actor_user_id,
        operation,
        idempotency_key,
        request_hash,
        status,
        locked_at,
        expires_at
      )
      VALUES ($1, $2, $3, $4, 'in_progress', NOW(), NOW() + INTERVAL '24 hours')
      ON CONFLICT (actor_user_id, operation, idempotency_key)
      DO UPDATE SET
        locked_at = idempotency_keys.locked_at
      RETURNING
        id,
        request_hash,
        status,
        response_status,
        response_body,
        completed_at,
        expires_at
      `,
      [params.actorUserId, params.operation, params.idempotencyKey, requestHash],
    );

    const row = claimRes.rows[0];
    if (!row) {
      throw new Error('Failed to claim idempotency key row');
    }

    if (row.request_hash !== requestHash) {
      throw new AppError(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key has already been used with a different request payload for this operation',
      );
    }

    if (row.status === 'completed' && row.response_status !== null && row.response_body !== null) {
      return {
        statusCode: row.response_status,
        body: row.response_body as T,
        replayed: true,
      };
    }

    const outcome = await handler(client);

    // Force immediate check of deferred database integrity triggers before marking completed
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');

    await client.query(
      `
      UPDATE idempotency_keys
      SET
        status = 'completed',
        response_status = $2,
        response_body = $3::jsonb,
        completed_at = NOW()
      WHERE id = $1
      `,
      [row.id, outcome.statusCode, JSON.stringify(outcome.body)],
    );

    return {
      statusCode: outcome.statusCode,
      body: outcome.body,
      replayed: false,
    };
  }, pool);
}
