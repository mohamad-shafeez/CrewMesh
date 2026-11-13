import type { FastifyInstance } from 'fastify';
import { getEnv } from '../config/env.js';
import { checkDatabaseReadiness, getDbPool } from '../db/pool.js';
import { AppError } from '../plugins/error-handler.js';

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

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  const livenessHandler = async () => ({
    status: 'ok',
    service: 'crewmesh-api',
    timestamp: new Date().toISOString(),
  });

  /**
   * GET /health & GET /healthz — Process liveness checks
   */
  app.get('/health', async (_request, reply) => {
    return reply.status(200).send(await livenessHandler());
  });

  app.get('/healthz', async (_request, reply) => {
    return reply.status(200).send(await livenessHandler());
  });

  /**
   * GET /ready — Readiness probe verifying real PostgreSQL connectivity
   */
  app.get('/ready', async (request, reply) => {
    const dbCheck = await checkDatabaseReadiness();
    if (!dbCheck.ready) {
      return reply.status(503).send({
        error: {
          code: 'DATABASE_UNAVAILABLE',
          message: 'Database readiness check failed',
          requestId: request.id,
          details: { latencyMs: dbCheck.latencyMs },
        },
      });
    }

    return reply.status(200).send({
      status: 'ready',
      database: 'connected',
      latencyMs: dbCheck.latencyMs,
      serverTimeIso: dbCheck.serverTimeIso,
    });
  });

  /**
   * GET /api/v1/hackathons/current — Returns the active Hack4Hack 2026 configuration
   */
  app.get('/api/v1/hackathons/current', async (_request, reply) => {
    const env = getEnv();
    const pool = getDbPool();
    const res = await pool.query<HackathonRow>(
      `
      SELECT
        id,
        slug,
        name,
        description,
        min_team_size,
        max_team_size,
        registration_deadline,
        is_active
      FROM hackathons
      WHERE slug = $1
      LIMIT 1
      `,
      [env.HACKATHON_SLUG],
    );

    const row = res.rows[0];
    if (!row) {
      throw new AppError(404, 'NOT_FOUND', 'Active hackathon configuration not found');
    }

    return reply.status(200).send({
      hackathon: {
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
      },
    });
  });
}
