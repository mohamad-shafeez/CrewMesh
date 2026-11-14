import type { Pool, PoolClient } from 'pg';
import type {
  JoinRequestDto,
  JoinRequestInboxPageResponse,
  JoinRequestSource,
  JoinRequestStatus,
  TeamDetailsDto,
} from '@crewmesh/shared';
import { getDbPool } from '../db/pool.js';
import { AppError } from '../plugins/error-handler.js';
import { insertAuditLog, insertOutboxEvent } from './audit-outbox-service.js';
import { decodeKeysetCursor, encodeKeysetCursor } from './cursor.js';
import {
  addMemberToLockedTeamTx,
  assertTeamLeaderTx,
  getTeamByIdOrThrow,
  lockActiveHackathonParticipantForUpdateTx,
  lockTeamByIdOrThrow,
  requireActiveHackathonParticipantTx,
  resolveHackathonOrThrow,
} from './team-service.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface JoinRequestRow {
  id: string;
  team_id: string;
  hackathon_id: string;
  user_id: string;
  source: JoinRequestSource;
  invite_code_id: string | null;
  message: string;
  status: JoinRequestStatus;
  decided_by_user_id: string | null;
  decided_at: Date | null;
  created_at: Date;
  updated_at: Date;
  applicant_display_name?: string;
  applicant_skills?: string[];
  applicant_timezone?: string | null;
  applicant_timezone_confirmed_at?: Date | null;
  applicant_bio?: string;
}

export function mapJoinRequestRow(row: JoinRequestRow): JoinRequestDto {
  const confirmedTimezone =
    row.applicant_timezone_confirmed_at !== undefined
      ? row.applicant_timezone_confirmed_at !== null
        ? (row.applicant_timezone ?? null)
        : null
      : (row.applicant_timezone ?? null);

  return {
    id: row.id,
    teamId: row.team_id,
    hackathonId: row.hackathon_id,
    userId: row.user_id,
    source: row.source,
    inviteCodeId: row.invite_code_id ?? null,
    message: row.message,
    status: row.status,
    decidedByUserId: row.decided_by_user_id,
    decidedAt:
      row.decided_at instanceof Date
        ? row.decided_at.toISOString()
        : row.decided_at
          ? String(row.decided_at)
          : null,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    ...(row.applicant_display_name !== undefined
      ? {
          applicant: {
            userId: row.user_id,
            displayName: row.applicant_display_name,
            skills: Array.isArray(row.applicant_skills) ? row.applicant_skills : [],
            timezone: confirmedTimezone,
            bio: row.applicant_bio ?? '',
          },
        }
      : {}),
  };
}

/**
 * Creates a pending join request for a team transactionally.
 */
export async function createJoinRequestTx(
  client: PoolClient,
  params: {
    teamId: string;
    actorUserId: string;
    message?: string;
    requestId?: string;
  },
): Promise<{ statusCode: number; body: { joinRequest: JoinRequestDto } }> {
  const team = await lockTeamByIdOrThrow(client, params.teamId);
  await resolveHackathonOrThrow(team.hackathon_id, client, {
    requireRegistrationOpen: true,
  });

  // Verify the applicant is an active registered participant in this hackathon (locked FOR SHARE)
  await requireActiveHackathonParticipantTx(client, team.hackathon_id, params.actorUserId);

  // Check if user is already in this team or another team in the same hackathon
  const memberCheck = await client.query<{ team_id: string }>(
    'SELECT team_id FROM team_members WHERE hackathon_id = $1 AND user_id = $2 LIMIT 1',
    [team.hackathon_id, params.actorUserId],
  );
  if (memberCheck.rows.length > 0) {
    throw new AppError(
      409,
      'ALREADY_IN_TEAM',
      'You already belong to a team in this hackathon',
    );
  }

  // Verify actual team capacity
  const countRes = await client.query<{ cnt: number }>(
    'SELECT COUNT(*)::int AS cnt FROM team_members WHERE team_id = $1',
    [team.id],
  );
  const currentCount = countRes.rows[0]?.cnt ?? team.member_count;

  if (currentCount >= team.max_team_size) {
    throw new AppError(409, 'TEAM_FULL', 'This team is already at full capacity');
  }

  if (!team.looking_for_members) {
    throw new AppError(
      409,
      'TEAM_NOT_RECRUITING',
      'This team is not currently accepting new join requests',
    );
  }

  let reqRow: JoinRequestRow;
  try {
    const insertRes = await client.query<JoinRequestRow>(
      `
      INSERT INTO join_requests (
        team_id,
        hackathon_id,
        user_id,
        source,
        invite_code_id,
        message,
        status
      )
      VALUES ($1, $2, $3, 'board', NULL, $4, 'pending')
      RETURNING
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
      `,
      [team.id, team.hackathon_id, params.actorUserId, (params.message ?? '').trim()],
    );
    reqRow = insertRes.rows[0]!;
  } catch (err) {
    const pgErr = err as { code?: string; constraint?: string };
    if (
      pgErr.code === '23505' &&
      pgErr.constraint === 'idx_join_requests_one_pending_per_team_user'
    ) {
      throw new AppError(
        409,
        'JOIN_REQUEST_ALREADY_EXISTS',
        'You already have a pending join request for this team',
      );
    }
    throw err;
  }

  await insertAuditLog(client, {
    hackathonId: team.hackathon_id,
    teamId: team.id,
    actorUserId: params.actorUserId,
    targetUserId: params.actorUserId,
    action: 'JOIN_REQUEST_CREATED',
    entityType: 'join_request',
    entityId: reqRow.id,
    requestId: params.requestId,
    metadata: {
      source: 'board',
    },
  });

  await insertOutboxEvent(client, {
    hackathonId: team.hackathon_id,
    teamId: team.id,
    scope: 'team',
    eventType: 'JOIN_REQUEST_CREATED',
    payload: {
      joinRequestId: reqRow.id,
      teamId: team.id,
      hackathonId: team.hackathon_id,
      applicantUserId: params.actorUserId,
      source: 'board',
      status: 'pending',
    },
  });

  return {
    statusCode: 201,
    body: {
      joinRequest: mapJoinRequestRow(reqRow),
    },
  };
}

/**
 * Lists join requests for a team's leader inbox with keyset pagination.
 * Enforces leader-only authorization against PostgreSQL.
 */
export async function listTeamJoinRequestsForLeader(
  params: {
    teamId: string;
    actorUserId: string;
    status?: JoinRequestStatus;
    cursor?: string;
    limit?: number;
  },
  pool: Pool = getDbPool(),
): Promise<JoinRequestInboxPageResponse> {
  if (!UUID_REGEX.test(params.teamId)) {
    throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found');
  }

  const teamRes = await pool.query<{ id: string; leader_user_id: string }>(
    'SELECT id, leader_user_id FROM teams WHERE id = $1 LIMIT 1',
    [params.teamId],
  );
  const team = teamRes.rows[0];
  if (!team) {
    throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found');
  }

  if (team.leader_user_id !== params.actorUserId) {
    throw new AppError(
      403,
      'UNAUTHORIZED_TEAM_ACTION',
      'Only the current team leader may view the team join-request inbox',
    );
  }

  const statusFilter = params.status ?? 'pending';
  const pageSize = Math.min(Math.max(params.limit ?? 25, 1), 100);

  const conditions: string[] = ['jr.team_id = $1', 'jr.status = $2'];
  const values: unknown[] = [params.teamId, statusFilter];

  if (params.cursor) {
    const decoded = decodeKeysetCursor(params.cursor);
    values.push(decoded.createdAt, decoded.id);
    const createdIdx = values.length - 1;
    const idIdx = values.length;
    conditions.push(
      `(jr.created_at, jr.id) > ($${createdIdx}::timestamptz, $${idIdx}::uuid)`,
    );
  }

  values.push(pageSize + 1);
  const limitIdx = values.length;

  const res = await pool.query<JoinRequestRow>(
    `
    SELECT
      jr.id,
      jr.team_id,
      jr.hackathon_id,
      jr.user_id,
      jr.source,
      jr.invite_code_id,
      jr.message,
      jr.status,
      jr.decided_by_user_id,
      jr.decided_at,
      jr.created_at,
      jr.updated_at,
      u.display_name AS applicant_display_name,
      u.skills AS applicant_skills,
      u.timezone AS applicant_timezone,
      u.timezone_confirmed_at AS applicant_timezone_confirmed_at,
      u.bio AS applicant_bio
    FROM join_requests jr
    INNER JOIN users u ON u.id = jr.user_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY jr.created_at ASC, jr.id ASC
    LIMIT $${limitIdx}
    `,
    values,
  );

  const hasMore = res.rows.length > pageSize;
  const slice = hasMore ? res.rows.slice(0, pageSize) : res.rows;
  const items = slice.map(mapJoinRequestRow);

  const lastRow = slice[slice.length - 1];
  const nextCursor =
    hasMore && lastRow
      ? encodeKeysetCursor({
          createdAt:
            lastRow.created_at instanceof Date
              ? lastRow.created_at.toISOString()
              : String(lastRow.created_at),
          id: lastRow.id,
        })
      : null;

  return {
    items,
    nextCursor,
    hasMore,
  };
}

/**
 * Race-proof and deadlock-free join request acceptance transaction:
 * 1. Locks the target `teams` row with `SELECT ... FOR UPDATE`.
 * 2. Verifies caller is the current leader in PostgreSQL and hackathon registration is open.
 * 3. Retrieves the target join request's applicant ID (`user_id`) using a non-locking `SELECT`.
 * 4. Acquires an exclusive participant-registration row lock (`FOR UPDATE` on `hackathon_participants`)
 *    BEFORE locking the `join_requests` row, serializing concurrent acceptances of the same applicant
 *    across different teams without deadlocking on cross-team `join_requests` cancellation.
 * 5. Verifies active participant eligibility (`status = 'registered'`).
 * 6. Checks whether that participant already belongs to a team in the hackathon; if so, returns `409 ALREADY_IN_TEAM`.
 * 7. Locks the target `join_requests` row (`FOR UPDATE`) and revalidates its `status`, `team_id`, and `user_id`.
 * 8. Executes membership creation (`addMemberToLockedTeamTx`) and marks the join request `'accepted'`.
 * 9. Cancels other pending join requests by that participant in the hackathon and expires remaining requests if full.
 * 10. Writes `JOIN_REQUEST_ACCEPTED` audit and outbox records within the same transaction.
 */
export async function acceptJoinRequestTx(
  client: PoolClient,
  params: {
    teamId: string;
    joinRequestId: string;
    actorUserId: string;
    requestId?: string;
  },
): Promise<{
  statusCode: number;
  body: { joinRequest: JoinRequestDto; team: TeamDetailsDto };
}> {
  if (!UUID_REGEX.test(params.joinRequestId)) {
    throw new AppError(404, 'JOIN_REQUEST_NOT_FOUND', 'Join request not found');
  }

  // Step 1: Lock target team row FOR UPDATE
  const team = await lockTeamByIdOrThrow(client, params.teamId);

  // Step 2: Verify leader permissions and active hackathon inside transaction
  await assertTeamLeaderTx(client, team, params.actorUserId);
  await resolveHackathonOrThrow(team.hackathon_id, client, {
    requireRegistrationOpen: true,
  });

  // Step 3: Non-locking lookup of the target join request to identify the applicant
  const prelimRes = await client.query<{
    id: string;
    team_id: string;
    hackathon_id: string;
    user_id: string;
    status: JoinRequestStatus;
  }>(
    `
    SELECT id, team_id, hackathon_id, user_id, status
    FROM join_requests
    WHERE id = $1
    LIMIT 1
    `,
    [params.joinRequestId],
  );

  const prelimReq = prelimRes.rows[0];
  if (!prelimReq || prelimReq.team_id !== team.id) {
    throw new AppError(404, 'JOIN_REQUEST_NOT_FOUND', 'Join request not found for this team');
  }

  // Steps 4 & 5: Acquire exclusive participant lock (FOR UPDATE) BEFORE locking join_requests
  // and verify active participant eligibility (status === 'registered')
  await lockActiveHackathonParticipantForUpdateTx(client, team.hackathon_id, prelimReq.user_id);

  // Steps 6 & 7: Check whether the participant already belongs to a team in the hackathon
  const existingMembership = await client.query<{ team_id: string }>(
    'SELECT team_id FROM team_members WHERE hackathon_id = $1 AND user_id = $2 LIMIT 1',
    [team.hackathon_id, prelimReq.user_id],
  );
  if (existingMembership.rows.length > 0) {
    throw new AppError(
      409,
      'ALREADY_IN_TEAM',
      'Participant already belongs to a team in this hackathon',
    );
  }

  // Step 8: Lock the target join_requests row FOR UPDATE and revalidate status, team_id, and user_id
  const reqRes = await client.query<JoinRequestRow>(
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
    WHERE id = $1
    FOR UPDATE
    `,
    [params.joinRequestId],
  );

  const joinReq = reqRes.rows[0];
  if (!joinReq || joinReq.team_id !== team.id || joinReq.user_id !== prelimReq.user_id) {
    throw new AppError(404, 'JOIN_REQUEST_NOT_FOUND', 'Join request not found for this team');
  }

  if (joinReq.status !== 'pending') {
    throw new AppError(
      409,
      'JOIN_REQUEST_ALREADY_PROCESSED',
      `Join request has already been ${joinReq.status}`,
    );
  }

  // Step 9: Execute membership creation and mark join_request 'accepted' transactionally
  const added = await addMemberToLockedTeamTx(client, {
    team,
    candidateUserId: joinReq.user_id,
    actorUserId: params.actorUserId,
    requestId: params.requestId,
    sourceAuditAction: 'JOIN_REQUEST_ACCEPTED',
    sourceEntityId: joinReq.id,
    sourceMetadata: {
      joinRequestId: joinReq.id,
      source: joinReq.source,
    },
  });

  const updatedReqRes = await client.query<JoinRequestRow>(
    `
    UPDATE join_requests
    SET
      status = 'accepted',
      decided_by_user_id = $2,
      decided_at = NOW(),
      updated_at = NOW()
    WHERE id = $1
    RETURNING
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
    `,
    [joinReq.id, params.actorUserId],
  );
  const updatedReq = updatedReqRes.rows[0]!;

  // Step 10: Cancel any other pending join requests by this user in the same hackathon safely
  await client.query(
    `
    UPDATE join_requests
    SET
      status = 'cancelled',
      updated_at = NOW()
    WHERE hackathon_id = $1
      AND user_id = $2
      AND status = 'pending'
      AND id <> $3
    `,
    [team.hackathon_id, joinReq.user_id, joinReq.id],
  );

  // If the team just reached max_team_size, automatically expire remaining pending requests for this team
  if (added.memberCount >= team.max_team_size) {
    await client.query(
      `
      UPDATE join_requests
      SET
        status = 'expired',
        updated_at = NOW()
      WHERE team_id = $1
        AND status = 'pending'
      `,
      [team.id],
    );
  }

  // Step 11: Write audit and outbox records within the same transaction
  await insertAuditLog(client, {
    hackathonId: team.hackathon_id,
    teamId: team.id,
    actorUserId: params.actorUserId,
    targetUserId: joinReq.user_id,
    action: 'JOIN_REQUEST_ACCEPTED',
    entityType: 'join_request',
    entityId: joinReq.id,
    requestId: params.requestId,
    metadata: {
      memberCount: added.memberCount,
      status: added.status,
    },
  });

  await insertOutboxEvent(client, {
    hackathonId: team.hackathon_id,
    teamId: team.id,
    scope: 'team',
    eventType: 'JOIN_REQUEST_ACCEPTED',
    payload: {
      joinRequestId: joinReq.id,
      teamId: team.id,
      hackathonId: team.hackathon_id,
      acceptedUserId: joinReq.user_id,
      decidedByUserId: params.actorUserId,
      memberCount: added.memberCount,
      status: added.status,
    },
  });

  const hydratedTeam = await getTeamByIdOrThrow(team.id, client);

  return {
    statusCode: 200,
    body: {
      joinRequest: mapJoinRequestRow(updatedReq),
      team: hydratedTeam,
    },
  };
}

/**
 * Declines a pending join request transactionally.
 */
export async function declineJoinRequestTx(
  client: PoolClient,
  params: {
    teamId: string;
    joinRequestId: string;
    actorUserId: string;
    requestId?: string;
  },
): Promise<{ statusCode: number; body: { joinRequest: JoinRequestDto } }> {
  if (!UUID_REGEX.test(params.joinRequestId)) {
    throw new AppError(404, 'JOIN_REQUEST_NOT_FOUND', 'Join request not found');
  }

  const team = await lockTeamByIdOrThrow(client, params.teamId);
  await assertTeamLeaderTx(client, team, params.actorUserId);

  const reqRes = await client.query<JoinRequestRow>(
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
    WHERE id = $1
    FOR UPDATE
    `,
    [params.joinRequestId],
  );

  const joinReq = reqRes.rows[0];
  if (!joinReq || joinReq.team_id !== team.id) {
    throw new AppError(404, 'JOIN_REQUEST_NOT_FOUND', 'Join request not found for this team');
  }

  if (joinReq.status !== 'pending') {
    throw new AppError(
      409,
      'JOIN_REQUEST_ALREADY_PROCESSED',
      `Join request has already been ${joinReq.status}`,
    );
  }

  const updatedRes = await client.query<JoinRequestRow>(
    `
    UPDATE join_requests
    SET
      status = 'declined',
      decided_by_user_id = $2,
      decided_at = NOW(),
      updated_at = NOW()
    WHERE id = $1
    RETURNING
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
    `,
    [joinReq.id, params.actorUserId],
  );

  const updatedReq = updatedRes.rows[0]!;

  await insertAuditLog(client, {
    hackathonId: team.hackathon_id,
    teamId: team.id,
    actorUserId: params.actorUserId,
    targetUserId: joinReq.user_id,
    action: 'JOIN_REQUEST_DECLINED',
    entityType: 'join_request',
    entityId: joinReq.id,
    requestId: params.requestId,
    metadata: {
      decidedByUserId: params.actorUserId,
    },
  });

  await insertOutboxEvent(client, {
    hackathonId: team.hackathon_id,
    teamId: team.id,
    scope: 'team',
    eventType: 'JOIN_REQUEST_DECLINED',
    payload: {
      joinRequestId: joinReq.id,
      teamId: team.id,
      hackathonId: team.hackathon_id,
      applicantUserId: joinReq.user_id,
      decidedByUserId: params.actorUserId,
      status: 'declined',
    },
  });

  return {
    statusCode: 200,
    body: {
      joinRequest: mapJoinRequestRow(updatedReq),
    },
  };
}
