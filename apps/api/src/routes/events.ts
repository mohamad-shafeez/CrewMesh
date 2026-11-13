import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDbPool } from '../db/pool.js';
import { requireAuth } from '../plugins/auth-session.js';
import { AppError } from '../plugins/error-handler.js';
import {
  OutboxSseDispatcher,
  parseLastEventId,
} from '../services/sse-dispatcher.js';
import { resolveHackathonOrThrow } from '../services/team-service.js';

const hackathonParamSchema = z.object({
  hackathonId: z.string().trim().min(2).max(64),
});

const teamParamSchema = z.object({
  teamId: z.string().uuid('Invalid teamId UUID'),
});

const sseQuerySchema = z.object({
  lastEventId: z.string().trim().optional(),
});

declare module 'fastify' {
  interface FastifyInstance {
    sseDispatcher: OutboxSseDispatcher;
  }
}

export async function registerEventRoutes(app: FastifyInstance): Promise<void> {
  const dispatcher = new OutboxSseDispatcher();
  app.decorate('sseDispatcher', dispatcher);

  app.addHook('onClose', async () => {
    await dispatcher.shutdown();
  });

  /**
   * GET /api/v1/hackathons/:hackathonId/events
   * Public SSE stream for hackathon board updates.
   * Honours `Last-Event-ID` header (or `?lastEventId=` query param) to replay missed board events.
   */
  app.get('/api/v1/hackathons/:hackathonId/events', async (request, reply) => {
    const params = hackathonParamSchema.parse(request.params);
    const query = sseQuerySchema.parse(request.query);
    const hackathon = await resolveHackathonOrThrow(params.hackathonId);

    const replaySinceId = parseLastEventId(
      request.headers['last-event-id'] ?? query.lastEventId,
    );

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Request-Id': request.id,
      'X-Content-Type-Options': 'nosniff',
    });

    raw.write('retry: 3000\n');
    raw.write(`: connected board=${hackathon.id}\n\n`);

    const subscriberId = `board_${crypto.randomUUID()}`;
    await dispatcher.registerSubscriber(
      {
        id: subscriberId,
        kind: 'board',
        hackathonId: hackathon.id,
        res: raw,
        lastSentEventId: 0n,
        closed: false,
        queuedFrames: 0,
      },
      replaySinceId,
    );
  });

  /**
   * GET /api/v1/teams/:teamId/events
   * Authenticated private SSE stream for team members and team leader.
   * Verifies current team membership against PostgreSQL on connect and before every event delivery.
   */
  app.get(
    '/api/v1/teams/:teamId/events',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const session = request.authSession!;
      const params = teamParamSchema.parse(request.params);
      const query = sseQuerySchema.parse(request.query);

      const replaySinceId = parseLastEventId(
        request.headers['last-event-id'] ?? query.lastEventId,
      );

      const pool = getDbPool();
      const teamRes = await pool.query<{ id: string; hackathon_id: string }>(
        'SELECT id, hackathon_id FROM teams WHERE id = $1 LIMIT 1',
        [params.teamId],
      );
      const team = teamRes.rows[0];
      if (!team) {
        throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found');
      }

      const memberRes = await pool.query<{ id: string; role: string }>(
        'SELECT id, role FROM team_members WHERE team_id = $1 AND user_id = $2 LIMIT 1',
        [team.id, session.user.id],
      );
      if (memberRes.rows.length === 0) {
        throw new AppError(
          403,
          'UNAUTHORIZED_TEAM_ACTION',
          'Only active members of this team may subscribe to its private event stream',
        );
      }

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Request-Id': request.id,
        'X-Content-Type-Options': 'nosniff',
      });

      raw.write('retry: 3000\n');
      raw.write(`: connected team=${team.id}\n\n`);

      const subscriberId = `team_${crypto.randomUUID()}`;
      await dispatcher.registerSubscriber(
        {
          id: subscriberId,
          kind: 'team',
          teamId: team.id,
          hackathonId: team.hackathon_id,
          userId: session.user.id,
          sessionId: session.sessionId,
          res: raw,
          lastSentEventId: 0n,
          closed: false,
          queuedFrames: 0,
        },
        replaySinceId,
      );
    },
  );
}
