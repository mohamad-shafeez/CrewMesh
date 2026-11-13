import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth-session.js';
import {
  executeIdempotentMutation,
  requireIdempotencyKeyHeader,
} from '../services/idempotency-service.js';
import {
  acceptJoinRequestTx,
  createJoinRequestTx,
  declineJoinRequestTx,
  listTeamJoinRequestsForLeader,
} from '../services/join-request-service.js';

const teamParamSchema = z.object({
  teamId: z.string().uuid('Invalid teamId UUID'),
});

const decisionParamSchema = z.object({
  teamId: z.string().uuid('Invalid teamId UUID'),
  requestId: z.string().uuid('Invalid requestId UUID'),
});

const createJoinRequestBodySchema = z
  .object({
    message: z.string().trim().max(500).optional().default(''),
  })
  .default({ message: '' });

const listInboxQuerySchema = z.object({
  status: z
    .enum(['pending', 'accepted', 'declined', 'cancelled', 'expired'])
    .optional()
    .default('pending'),
  cursor: z.string().trim().min(4).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
});

export async function registerJoinRequestRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/v1/teams/:teamId/join-requests
   * Authenticated participant submits a join request for a team.
   */
  app.post(
    '/api/v1/teams/:teamId/join-requests',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const session = request.authSession!;
      const idempotencyKey = requireIdempotencyKeyHeader(request.headers['idempotency-key']);
      const params = teamParamSchema.parse(request.params);
      const body = createJoinRequestBodySchema.parse(request.body ?? {});

      const result = await executeIdempotentMutation(
        {
          actorUserId: session.user.id,
          operation: `POST:/api/v1/teams/${params.teamId}/join-requests`,
          idempotencyKey,
          requestPayload: { params, body },
        },
        async (client) =>
          createJoinRequestTx(client, {
            teamId: params.teamId,
            actorUserId: session.user.id,
            message: body.message,
            requestId: request.id,
          }),
      );

      if (result.replayed) {
        reply.header('X-Idempotent-Replay', 'true');
      }
      return reply.status(result.statusCode).send(result.body);
    },
  );

  /**
   * GET /api/v1/teams/:teamId/join-requests
   * Leader-only paginated join request inbox.
   */
  app.get(
    '/api/v1/teams/:teamId/join-requests',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const session = request.authSession!;
      const params = teamParamSchema.parse(request.params);
      const query = listInboxQuerySchema.parse(request.query);

      const page = await listTeamJoinRequestsForLeader({
        teamId: params.teamId,
        actorUserId: session.user.id,
        status: query.status,
        cursor: query.cursor,
        limit: query.limit,
      });

      return reply.status(200).send(page);
    },
  );

  /**
   * POST /api/v1/teams/:teamId/join-requests/:requestId/accept
   * Leader accepts a pending join request using the row-locked last-seat concurrency engine.
   */
  app.post(
    '/api/v1/teams/:teamId/join-requests/:requestId/accept',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const session = request.authSession!;
      const idempotencyKey = requireIdempotencyKeyHeader(request.headers['idempotency-key']);
      const params = decisionParamSchema.parse(request.params);

      const result = await executeIdempotentMutation(
        {
          actorUserId: session.user.id,
          operation: `POST:/api/v1/teams/${params.teamId}/join-requests/${params.requestId}/accept`,
          idempotencyKey,
          requestPayload: { params },
        },
        async (client) =>
          acceptJoinRequestTx(client, {
            teamId: params.teamId,
            joinRequestId: params.requestId,
            actorUserId: session.user.id,
            requestId: request.id,
          }),
      );

      if (result.replayed) {
        reply.header('X-Idempotent-Replay', 'true');
      }
      return reply.status(result.statusCode).send(result.body);
    },
  );

  /**
   * POST /api/v1/teams/:teamId/join-requests/:requestId/decline
   * Leader declines a pending join request transactionally.
   */
  app.post(
    '/api/v1/teams/:teamId/join-requests/:requestId/decline',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const session = request.authSession!;
      const idempotencyKey = requireIdempotencyKeyHeader(request.headers['idempotency-key']);
      const params = decisionParamSchema.parse(request.params);

      const result = await executeIdempotentMutation(
        {
          actorUserId: session.user.id,
          operation: `POST:/api/v1/teams/${params.teamId}/join-requests/${params.requestId}/decline`,
          idempotencyKey,
          requestPayload: { params },
        },
        async (client) =>
          declineJoinRequestTx(client, {
            teamId: params.teamId,
            joinRequestId: params.requestId,
            actorUserId: session.user.id,
            requestId: request.id,
          }),
      );

      if (result.replayed) {
        reply.header('X-Idempotent-Replay', 'true');
      }
      return reply.status(result.statusCode).send(result.body);
    },
  );
}
