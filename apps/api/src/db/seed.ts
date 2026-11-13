import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import type { HackathonSummary } from '@crewmesh/shared';
import { getEnv } from '../config/env.js';
import { closeDbPool, getDbPool, withTransaction } from './pool.js';

const __filename = fileURLToPath(import.meta.url);

interface HackathonRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  min_team_size: number;
  max_team_size: number;
  registration_deadline: Date | null;
  is_active: boolean;
}

/**
 * Idempotently seeds the Hack4Hack Crew Hiring Challenge 2026 hackathon record.
 * Uses NULL for registration_deadline unless HACKATHON_DEADLINE_ISO is explicitly provided.
 */
export async function seedHackathon(pool: Pool = getDbPool()): Promise<HackathonSummary> {
  const env = getEnv();
  const description =
    'Hack4Hack Crew Hiring Challenge 2026 — PS1: Race-proof team formation at scale. ' +
    'Teams below minimum size remain in forming status until minimum capacity is reached.';

  return withTransaction(async (client) => {
    const res = await client.query<HackathonRow>(
      `
      INSERT INTO hackathons (
        slug,
        name,
        description,
        min_team_size,
        max_team_size,
        registration_deadline,
        is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6::timestamptz, TRUE)
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        min_team_size = EXCLUDED.min_team_size,
        max_team_size = EXCLUDED.max_team_size,
        registration_deadline = EXCLUDED.registration_deadline,
        is_active = TRUE,
        updated_at = NOW()
      RETURNING
        id,
        slug,
        name,
        description,
        min_team_size,
        max_team_size,
        registration_deadline,
        is_active
      `,
      [
        env.HACKATHON_SLUG,
        env.HACKATHON_NAME,
        description,
        env.HACKATHON_MIN_TEAM_SIZE,
        env.HACKATHON_MAX_TEAM_SIZE,
        env.HACKATHON_DEADLINE_ISO,
      ],
    );

    const row = res.rows[0];
    if (!row) {
      throw new Error('Failed to seed hackathon record');
    }

    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      minTeamSize: row.min_team_size,
      maxTeamSize: row.max_team_size,
      registrationDeadline:
        row.registration_deadline instanceof Date
          ? row.registration_deadline.toISOString()
          : row.registration_deadline
            ? String(row.registration_deadline)
            : null,
      isActive: row.is_active,
    };
  }, pool);
}

async function runCli(): Promise<void> {
  try {
    const hackathon = await seedHackathon();
    console.info(
      JSON.stringify({
        action: 'db:seed:hackathon',
        hackathon,
      }),
    );
  } finally {
    await closeDbPool();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runCli().catch((err) => {
    console.error(
      JSON.stringify({
        error: 'SEED_FAILED',
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    process.exitCode = 1;
  });
}
