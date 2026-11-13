import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { closeDbPool, getDbPool, withTransaction } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_LOCK_KEY = 842_026_001;

export interface MigrationRecord {
  version: string;
  name: string;
  checksum: string;
  applied_at: Date;
}

function sha256Checksum(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function getMigrationsDir(): string {
  return path.resolve(__dirname, '../../migrations');
}

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

/**
 * Applies all pending `.up.sql` migrations in lexical order inside an advisory lock.
 * Verifies checksums of already-applied migrations to detect drift.
 */
export async function runMigrationsUp(
  pool: Pool = getDbPool(),
  migrationsDir: string = getMigrationsDir(),
): Promise<string[]> {
  await ensureMigrationsTable(pool);

  const entries = await fs.readdir(migrationsDir);
  const upFiles = entries.filter((f) => f.endsWith('.up.sql')).sort();
  const appliedVersions: string[] = [];

  await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);

    const existingRes = await client.query<MigrationRecord>(
      'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC',
    );
    const existingByVersion = new Map<string, MigrationRecord>();
    for (const row of existingRes.rows) {
      existingByVersion.set(row.version, row);
    }

    for (const filename of upFiles) {
      const baseName = filename.replace(/\.up\.sql$/, '');
      const [versionPart, ...nameParts] = baseName.split('_');
      const version = versionPart ?? baseName;
      const name = nameParts.join('_') || baseName;

      const filePath = path.join(migrationsDir, filename);
      const sqlContent = await fs.readFile(filePath, 'utf8');
      const checksum = sha256Checksum(sqlContent);

      const alreadyApplied = existingByVersion.get(version);
      if (alreadyApplied) {
        if (alreadyApplied.checksum !== checksum) {
          throw new Error(
            `Migration checksum mismatch for version ${version} (${filename}): expected ${alreadyApplied.checksum}, got ${checksum}`,
          );
        }
        continue;
      }

      await client.query(sqlContent);
      await client.query(
        'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [version, name, checksum],
      );
      appliedVersions.push(version);
    }
  }, pool);

  return appliedVersions;
}

/**
 * Rolls back the most recently applied migration using its corresponding `.down.sql` file.
 * Refuses to run in production unless explicitly forced.
 */
export async function runMigrationDown(
  pool: Pool = getDbPool(),
  migrationsDir: string = getMigrationsDir(),
): Promise<string | null> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run destructive down migration in production environment');
  }

  await ensureMigrationsTable(pool);
  let rolledBackVersion: string | null = null;

  await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);

    const latestRes = await client.query<MigrationRecord>(
      'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 1',
    );
    const latest = latestRes.rows[0];
    if (!latest) {
      return;
    }

    const downFilename = `${latest.version}_${latest.name}.down.sql`;
    const downPath = path.join(migrationsDir, downFilename);
    const downSql = await fs.readFile(downPath, 'utf8');

    await client.query(downSql);
    await client.query('DELETE FROM schema_migrations WHERE version = $1', [latest.version]);
    rolledBackVersion = latest.version;
  }, pool);

  return rolledBackVersion;
}

/**
 * Lists applied migrations from `schema_migrations`.
 */
export async function getMigrationStatus(pool: Pool = getDbPool()): Promise<MigrationRecord[]> {
  await ensureMigrationsTable(pool);
  const res = await pool.query<MigrationRecord>(
    'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC',
  );
  return res.rows;
}

async function runCli(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  try {
    if (command === 'up') {
      const applied = await runMigrationsUp();
      console.info(
        JSON.stringify({
          action: 'db:migrate:up',
          appliedCount: applied.length,
          appliedVersions: applied,
        }),
      );
    } else if (command === 'down') {
      const rolledBack = await runMigrationDown();
      console.info(
        JSON.stringify({
          action: 'db:migrate:down',
          rolledBackVersion: rolledBack,
        }),
      );
    } else if (command === 'status') {
      const status = await getMigrationStatus();
      console.info(JSON.stringify({ action: 'db:migrate:status', migrations: status }, null, 2));
    } else {
      throw new Error(`Unknown migration command: ${command}. Expected 'up', 'down', or 'status'.`);
    }
  } finally {
    await closeDbPool();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runCli().catch((err) => {
    console.error(
      JSON.stringify({
        error: 'MIGRATION_FAILED',
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    process.exitCode = 1;
  });
}
