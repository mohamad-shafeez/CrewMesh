import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth-session.js';
import { AppError } from '../plugins/error-handler.js';
import { sha256Hex } from '../security/crypto.js';
import { consumeRateLimitBucket } from '../security/rate-limit.js';
import {
  executeIdempotentMutation,
  requireIdempotencyKeyHeader,
} from '../services/idempotency-service.js';
import {
  createInviteCodeTx,
  listTeamInvitesForLeader,
  redeemInviteCodeTx,
  revokeInviteCodeTx,
} from '../services/invite-service.js';

const teamParamSchema = z.object({
  teamId: z.string().uuid('Invalid teamId UUID'),
});

const revokeInviteParamSchema = z.object({
  teamId: z.string().uuid('Invalid teamId UUID'),
  inviteId: z.string().uuid('Invalid inviteId UUID'),
});

const createInviteBodySchema = z
  .object({
    expiresInHours: z.number().min(0.01).max(720).optional(),
    expiresAt: z
      .string()
      .refine((v) => !Number.isNaN(Date.parse(v)), 'expiresAt must be a valid ISO timestamp')
      .optional(),
    maxUses: z.number().int().min(1).max(100).nullable().optional(),
  })
  .default({});

const redeemInviteBodySchema = z.object({
  code: z
    .string()
    .trim()
    .min(16, 'Invalid invitation code')
    .max(128, 'Invalid invitation code'),
  message: z.string().trim().max(500).optional().default(''),
});

export async function registerInviteRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/v1/teams/:teamId/invites
   * Leader-only endpoint returning invitation metadata (never raw codes or token hashes).
   */
  app.get(
    '/api/v1/teams/:teamId/invites',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const session = request.authSession!;
      const params = teamParamSchema.parse(request.params);

      const invites = await listTeamInvitesForLeader({
        teamId: params.teamId,
        actorUserId: session.user.id,
      });

      return reply.status(200).send({ invites });
    },
  );

  /**
   * POST /api/v1/teams/:teamId/invites
   * Leader creates a 256-bit invitation code (storing only its SHA-256 hash).
   */
  app.post(
    '/api/v1/teams/:teamId/invites',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const session = request.authSession!;
      const idempotencyKey = requireIdempotencyKeyHeader(request.headers['idempotency-key']);
      const params = teamParamSchema.parse(request.params);
      const body = createInviteBodySchema.parse(request.body ?? {});

      const result = await executeIdempotentMutation(
        {
          actorUserId: session.user.id,
          operation: `POST:/api/v1/teams/${params.teamId}/invites`,
          idempotencyKey,
          requestPayload: { params, body },
        },
        async (client) =>
          createInviteCodeTx(client, {
            teamId: params.teamId,
            actorUserId: session.user.id,
            expiresInHours: body.expiresInHours,
            expiresAtIso: body.expiresAt,
            maxUses: body.maxUses,
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
   * POST /api/v1/teams/:teamId/invites/:inviteId/revoke
   * Leader revokes an invitation code transactionally.
   */
  app.post(
    '/api/v1/teams/:teamId/invites/:inviteId/revoke',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const session = request.authSession!;
      const idempotencyKey = requireIdempotencyKeyHeader(request.headers['idempotency-key']);
      const params = revokeInviteParamSchema.parse(request.params);

      const result = await executeIdempotentMutation(
        {
          actorUserId: session.user.id,
          operation: `POST:/api/v1/teams/${params.teamId}/invites/${params.inviteId}/revoke`,
          idempotencyKey,
          requestPayload: { params },
        },
        async (client) =>
          revokeInviteCodeTx(client, {
            teamId: params.teamId,
            inviteId: params.inviteId,
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
   * DELETE /api/v1/teams/:teamId/invites/:inviteId
   * RESTful alias for revoking an invitation code.
   */
  app.delete(
    '/api/v1/teams/:teamId/invites/:inviteId',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const session = request.authSession!;
      const idempotencyKey = requireIdempotencyKeyHeader(request.headers['idempotency-key']);
      const params = revokeInviteParamSchema.parse(request.params);

      const result = await executeIdempotentMutation(
        {
          actorUserId: session.user.id,
          operation: `DELETE:/api/v1/teams/${params.teamId}/invites/${params.inviteId}`,
          idempotencyKey,
          requestPayload: { params },
        },
        async (client) =>
          revokeInviteCodeTx(client, {
            teamId: params.teamId,
            inviteId: params.inviteId,
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
   * POST /api/v1/invites/redeem
   * Authenticated participant redeems an invitation code to create a pending join request
   * for leader approval. Protected by per-IP and per-user rate limits in PostgreSQL.
   */
  app.post(
    '/api/v1/invites/redeem',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const session = request.authSession!;
      const idempotencyKey = requireIdempotencyKeyHeader(request.headers['idempotency-key']);

      const [ipLimit, userLimit] = await Promise.all([
        consumeRateLimitBucket({
          scope: 'invite_ip',
          identifier: `redeem:${request.ip}`,
          limit: 60,
          windowSeconds: 60,
        }),
        consumeRateLimitBucket({
          scope: 'invite_user',
          identifier: `redeem:${session.user.id}`,
          limit: 15,
          windowSeconds: 60,
        }),
      ]);

      if (!ipLimit.allowed || !userLimit.allowed) {
        const retryAfter = Math.max(ipLimit.retryAfterSeconds, userLimit.retryAfterSeconds);
        reply.header('Retry-After', String(retryAfter));
        throw new AppError(
          429,
          'RATE_LIMITED',
          'Too many invitation redemption attempts. Please wait before trying again.',
        );
      }

      const body = redeemInviteBodySchema.parse(request.body);

      const result = await executeIdempotentMutation(
        {
          actorUserId: session.user.id,
          operation: 'POST:/api/v1/invites/redeem',
          idempotencyKey,
          requestPayload: { codeHash: sha256Hex(body.code), message: body.message },
        },
        async (client) =>
          redeemInviteCodeTx(client, {
            rawCode: body.code,
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
}
