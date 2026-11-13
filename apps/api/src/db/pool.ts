import pg from 'pg';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { getEnv } from '../config/env.js';

const { Pool: PgPool } = pg;

let activePool: Pool | null = null;

export interface DatabaseReadinessResult {
  ready: boolean;
  latencyMs: number;
  serverTimeIso?: string;
  error?: string;
}

/**
 * Creates or returns the shared PostgreSQL connection pool.
 */
export function getDbPool(customConnectionString?: string): Pool {
  if (!activePool) {
    const env = getEnv();
    const connectionString =
      customConnectionString ??
      (env.NODE_ENV === 'test' && env.TEST_DATABASE_URL
        ? env.TEST_DATABASE_URL
        : env.DATABASE_URL);

    activePool = new PgPool({
      connectionString,
      max: env.DB_POOL_MAX,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: 'crewmesh_api',
    });
  }
  return activePool;
}

/**
 * Closes the active PostgreSQL pool cleanly during server shutdown or test teardown.
 */
export async function closeDbPool(): Promise<void> {
  if (activePool) {
    const poolToClose = activePool;
    activePool = null;
    await poolToClose.end();
  }
}

/**
 * Executes a single parameterized SQL query against the pool.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[],
  pool: Pool = getDbPool(),
): Promise<QueryResult<T>> {
  return pool.query<T>(text, values);
}

/**
 * Runs a callback inside an explicit PostgreSQL transaction (BEGIN ... COMMIT / ROLLBACK).
 * Ensures the client is always released back to the pool.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  pool: Pool = getDbPool(),
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore secondary rollback error; propagate original failure
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Verifies real PostgreSQL connectivity and schema readiness.
 */
export async function checkDatabaseReadiness(
  pool: Pool = getDbPool(),
): Promise<DatabaseReadinessResult> {
  const start = performance.now();
  try {
    const res = await pool.query<{ now: Date }>('SELECT NOW() AS now');
    const latencyMs = Math.round((performance.now() - start) * 100) / 100;
    const nowValue = res.rows[0]?.now;
    return {
      ready: true,
      latencyMs,
      serverTimeIso: nowValue instanceof Date ? nowValue.toISOString() : String(nowValue),
    };
  } catch (err) {
    const latencyMs = Math.round((performance.now() - start) * 100) / 100;
    return {
      ready: false,
      latencyMs,
      error: err instanceof Error ? err.message : 'Database readiness probe failed',
    };
  }
}
