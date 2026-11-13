import type { Pool } from 'pg';
import { getDbPool } from '../db/pool.js';

export type RateLimitScope =
  | 'auth_ip'
  | 'auth_email'
  | 'invite_ip'
  | 'invite_user'
  | 'suggestions_user';

export interface RateLimitCheckResult {
  allowed: boolean;
  currentHits: number;
  limit: number;
  retryAfterSeconds: number;
}

/**
 * Shared PostgreSQL-backed rate limiter using `rate_limit_buckets`.
 * Atomically increments or resets expired windows in a single UPSERT statement.
 */
export async function consumeRateLimitBucket(
  params: {
    scope: RateLimitScope;
    identifier: string;
    limit: number;
    windowSeconds: number;
  },
  pool: Pool = getDbPool(),
): Promise<RateLimitCheckResult> {
  const bucketKey = `${params.scope}:${params.identifier}`;
  const res = await pool.query<{
    hits: number;
    retry_after_seconds: number;
  }>(
    `
    INSERT INTO rate_limit_buckets (bucket_key, scope, hits, window_start, expires_at)
    VALUES ($1, $2, 1, NOW(), NOW() + ($3 * INTERVAL '1 second'))
    ON CONFLICT (bucket_key) DO UPDATE SET
      hits = CASE
        WHEN rate_limit_buckets.expires_at <= NOW() THEN 1
        ELSE rate_limit_buckets.hits + 1
      END,
      window_start = CASE
        WHEN rate_limit_buckets.expires_at <= NOW() THEN NOW()
        ELSE rate_limit_buckets.window_start
      END,
      expires_at = CASE
        WHEN rate_limit_buckets.expires_at <= NOW() THEN NOW() + ($3 * INTERVAL '1 second')
        ELSE rate_limit_buckets.expires_at
      END
    RETURNING
      hits,
      GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - NOW()))))::int AS retry_after_seconds
    `,
    [bucketKey, params.scope, params.windowSeconds],
  );

  const row = res.rows[0];
  const currentHits = row?.hits ?? 1;
  const retryAfterSeconds = row?.retry_after_seconds ?? params.windowSeconds;

  return {
    allowed: currentHits <= params.limit,
    currentHits,
    limit: params.limit,
    retryAfterSeconds,
  };
}
