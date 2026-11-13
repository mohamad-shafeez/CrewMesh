import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TeamRole, TeamViewerContextDto } from '@crewmesh/shared';
import { getDbPool } from '../db/pool.js';
import { requireAuth } from '../plugins/auth-session.js';
import { AppError } from '../plugins/error-handler.js';
import { consumeRateLimitBucket } from '../security/rate-limit.js';
import {
  executeIdempotentMutation,
  requireIdempotencyKeyHeader,
} from '../services/idempotency-service.js';
import { mapJoinRequestRow, type JoinRequestRow } from '../services/join-request-service.js';
import { getTeammateSuggestionsForLeader } from '../services/suggestion-service.js';
import {
  createTeamTx,
  getTeamByIdOrThrow,
  leaveTeamTx,
  listTeamBoard,
  removeMemberTx,
  updateTeamPreferencesTx,
} from '../services/team-service.js';

const hackathonParamSchema = z.object({
  hackathonId: z.string().trim().min(2).max(64),
});

const teamParamSchema = z.object({
  teamId: z.string().uuid('Invalid teamId UUID'),
});

const removeMemberParamSchema = z.object({
  teamId: z.string().uuid('Invalid teamId UUID'),
  memberUserId: z.string().uuid('Invalid memberUserId UUID'),
});

const createTeamBodySchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Team name must be at least 2 characters')
    .max(80, 'Team name must not exceed 80 characters'),
  description: z.string().trim().max(1000).optional().default(''),
  desiredSkills: z.array(z.string().trim().min(1).max(40)).max(25).optional().default([]),
  lookingForMembers: z.boolean().optional().default(true),
  minTeamSize: z.number().int().min(1).max(20).optional(),
  maxTeamSize: z.number().int().min(1).max(20).optional(),
});

const updateTeamPreferencesBodySchema = z.object({
  desiredSkills: z
    .array(
      z
        .string()
        .trim()
        .min(1, 'Skill tag cannot be empty')
        .max(40, 'Skill tag must not exceed 40 characters'),
    )
    .max(25, 'A team may specify at most 25 desired skills'),
  lookingForMembers: z.boolean().optional(),
});

const suggestionsQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int('limit must be an integer')
    .min(1, 'limit must be at least 1')
    .max(50, 'limit must not exceed 50')
    .optional()
    .default(20),
});

const boardQuerySchema = z.object({
  cursor: z.string().trim().min(4).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  status: z.enum(['forming', 'ready']).optional(),
  hasCapacity: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  lookingForMembers: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  skill: z.string().trim().max(40).optional(),
  search: z.string().trim().max(100).optional(),
});

export async function registerTeamRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/v1/hackathons/:hackathonId/teams
   * Creates a new team and sets the authenticated user as its initial leader in one transaction.
   */
  app.post(
    '/api/v1/hackathons/:hackathonId/teams',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const session = request.authSession!;
      const idempotencyKey = requireIdempotencyKeyHeader(request.headers['idempotency-key']);
      const params = hackathonParamSchema.parse(request.params);
      const body = createTeamBodySchema.parse(request.body);

      const result = await executeIdempotentMutation(
        {
          actorUserId: session.user.id,
          operation: `POST:/api/v1/hackathons/${params.hackathonId}/teams`,
          idempotencyKey,
          requestPayload: { params, body },
        },
        async (client) =>
          createTeamTx(client, {
            hackathonIdOrSlug: params.hackathonId,
            actorUserId: session.user.id,
            name: body.name,
            description: body.description,
            desiredSkills: body.desiredSkills,
            lookingForMembers: body.lookingForMembers,
            minTeamSizeOverride: body.minTeamSize,
            maxTeamSizeOverride: body.maxTeamSize,
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
   * GET /api/v1/hackathons/:hackathonId/teams
   * Keyset-paginated public team board with status, capacity, skill, and search filters.
   */
  app.get('/api/v1/hackathons/:hackathonId/teams', async (request, reply) => {
    const params = hackathonParamSchema.parse(request.params);
    const query = boardQuerySchema.parse(request.query);

    const boardPage = await listTeamBoard({
      hackathonIdOrSlug: params.hackathonId,
      cursor: query.cursor,
      limit: query.limit,
      status: query.status,
      hasCapacity: query.hasCapacity,
      lookingForMembers: query.lookingForMembers,
      skill: query.skill,
      search: query.search,
    });

    return reply.status(200).send(boardPage);
  });

  /**
   * GET /api/v1/teams/:teamId
   * Retrieves complete public team details, members, leader, capacity, and status.
   */
  app.get('/api/v1/teams/:teamId', async (request, reply) => {
    const params = teamParamSchema.parse(request.params);
    const team = await getTeamByIdOrThrow(params.teamId);

    let viewerContext: TeamViewerContextDto | null = null;
    if (request.authSession) {
      const pool = getDbPool();
      const userId = request.authSession.user.id;
      const [membershipRes, jrRes] = await Promise.all([
        pool.query<{ team_id: string; role: TeamRole }>(
          'SELECT team_id, role FROM team_members WHERE hackathon_id = $1 AND user_id = $2 LIMIT 1',
          [team.hackathonId, userId],
        ),
        pool.query<JoinRequestRow>(
          `
          SELECT
            id,
            team_id,
            hackathon_id,
            user_id,
            source,
            invite_code_id,
            message,
            status,
            decided_by_user_id,
            decided_at,
            created_at,
            updated_at
          FROM join_requests
          WHERE team_id = $1 AND user_id = $2
          ORDER BY created_at DESC
          LIMIT 1
          `,
          [team.id, userId],
        ),
      ]);

      const memberRow = membershipRes.rows[0];
      const jrRow = jrRes.rows[0];

      viewerContext = {
        myTeamIdInHackathon: memberRow?.team_id ?? null,
        myRoleInTeam: memberRow && memberRow.team_id === team.id ? memberRow.role : null,
        myJoinRequestForTeam: jrRow ? mapJoinRequestRow(jrRow) : null,
      };
    }

    return reply.status(200).send({ team, viewerContext });
  });

  /**
   * GET /api/v1/teams/:teamId/suggestions
   * Leader-only endpoint returning explainable teammate recommendations (crewmesh-match-v1).
   */
  app.get(
    '/api/v1/teams/:teamId/suggestions',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const session = request.authSession!;
      const params = teamParamSchema.parse(request.params);
      const query = suggestionsQuerySchema.parse(request.query);

      const rateCheck = await consumeRateLimitBucket({
        scope: 'suggestions_user',
        identifier: `suggestions:${session.user.id}`,
        limit: 30,
        windowSeconds: 60,
      });

      if (!rateCheck.allowed) {
        reply.header('Retry-After', String(rateCheck.retryAfterSeconds));
        throw new AppError(
          429,
          'RATE_LIMITED',
          'Too many teammate suggestion requests. Please wait a moment and try again.',
        );
      }

      const suggestions = await getTeammateSuggestionsForLeader({
        teamId: params.teamId,
        actorUserId: session.user.id,
        limit: query.limit,
      });

      return reply.status(200).send(suggestions);
    },
  );

  /**
   * PATCH /api/v1/teams/:teamId/preferences
   * Leader updates team desired skills and recruiting status transactionally with Idempotency-Key.
   */
  app.patch(
    '/api/v1/teams/:teamId/preferences',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const session = request.authSession!;
      const idempotencyKey = requireIdempotencyKeyHeader(request.headers['idempotency-key']);
      const params = teamParamSchema.parse(request.params);
      const body = updateTeamPreferencesBodySchema.parse(request.body);

      const result = await executeIdempotentMutation(
        {
          actorUserId: session.user.id,
          operation: `PATCH:/api/v1/teams/${params.teamId}/preferences`,
          idempotencyKey,
          requestPayload: { params, body },
        },
        async (client) =>
          updateTeamPreferencesTx(client, {
            teamId: params.teamId,
            actorUserId: session.user.id,
            desiredSkills: body.desiredSkills,
            lookingForMembers: body.lookingForMembers,
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
   * DELETE /api/v1/teams/:teamId/members/:memberUserId
   * Leader removes another member from the team transactionally.
   */
  app.delete(
    '/api/v1/teams/:teamId/members/:memberUserId',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const session = request.authSession!;
      const idempotencyKey = requireIdempotencyKeyHeader(request.headers['idempotency-key']);
      const params = removeMemberParamSchema.parse(request.params);

      const result = await executeIdempotentMutation(
        {
          actorUserId: session.user.id,
          operation: `DELETE:/api/v1/teams/${params.teamId}/members/${params.memberUserId}`,
          idempotencyKey,
          requestPayload: { params },
        },
        async (client) =>
          removeMemberTx(client, {
            teamId: params.teamId,
            actorUserId: session.user.id,
            targetUserId: params.memberUserId,
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
   * POST /api/v1/teams/:teamId/leave
   * Member leaves the team transactionally (handling leader succession or last-member team deletion).
   */
  app.post(
    '/api/v1/teams/:teamId/leave',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const session = request.authSession!;
      const idempotencyKey = requireIdempotencyKeyHeader(request.headers['idempotency-key']);
      const params = teamParamSchema.parse(request.params);

      const result = await executeIdempotentMutation(
        {
          actorUserId: session.user.id,
          operation: `POST:/api/v1/teams/${params.teamId}/leave`,
          idempotencyKey,
          requestPayload: { params },
        },
        async (client) =>
          leaveTeamTx(client, {
            teamId: params.teamId,
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
