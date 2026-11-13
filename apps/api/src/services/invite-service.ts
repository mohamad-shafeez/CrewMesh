import type { Pool, PoolClient } from 'pg';
import type {
  InviteCodeCreatedDto,
  InviteCodeMetadataDto,
  InviteRedeemResultDto,
} from '@crewmesh/shared';
import { getDbPool } from '../db/pool.js';
import { AppError } from '../plugins/error-handler.js';
import { generateOpaqueToken, sha256Hex } from '../security/crypto.js';
import { insertAuditLog, insertOutboxEvent } from './audit-outbox-service.js';
import {
  mapJoinRequestRow,
  type JoinRequestRow,
} from './join-request-service.js';
import {
  assertTeamLeaderTx,
  lockTeamByIdOrThrow,
  requireActiveHackathonParticipantTx,
  resolveHackathonOrThrow,
} from './team-service.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface InviteCodeRow {
  id: string;
  team_id: string;
  hackathon_id: string;
  token_hash: string;
  token_prefix: string;
  created_by_user_id: string;
  max_uses: number | null;
  use_count: number;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

interface InviteMetadataQueryRow {
  id: string;
  team_id: string;
  hackathon_id: string;
  token_prefix: string;
  created_by_user_id: string;
  max_uses: number | null;
  use_count: number;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
  is_expired: boolean;
}

/**
 * Lists invitation metadata for a team's leader.
 * Verifies leader role against PostgreSQL and NEVER returns raw codes or token_hash.
 */
export async function listTeamInvitesForLeader(
  params: {
    teamId: string;
    actorUserId: string;
  },
  pool: Pool = getDbPool(),
): Promise<InviteCodeMetadataDto[]> {
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
      'Only the current team leader may view team invitations',
    );
  }

  const leaderMemberCheck = await pool.query<{ id: string }>(
    "SELECT id FROM team_members WHERE team_id = $1 AND user_id = $2 AND role = 'leader' LIMIT 1",
    [team.id, params.actorUserId],
  );
  if (leaderMemberCheck.rows.length === 0) {
    throw new AppError(
      403,
      'UNAUTHORIZED_TEAM_ACTION',
      'Only the current team leader may view team invitations',
    );
  }

  const res = await pool.query<InviteMetadataQueryRow>(
    `
    SELECT
      id,
      team_id,
      hackathon_id,
      token_prefix,
      created_by_user_id,
      max_uses,
      use_count,
      expires_at,
      revoked_at,
      created_at,
      (expires_at <= NOW()) AS is_expired
    FROM invite_codes
    WHERE team_id = $1
    ORDER BY created_at DESC, id DESC
    LIMIT 100
    `,
    [team.id],
  );

  return res.rows.map((row) => {
    const isRevoked = row.revoked_at !== null;
    const isExpired = Boolean(row.is_expired);
    const isExhausted = row.max_uses !== null && row.use_count >= row.max_uses;

    return {
      id: row.id,
      teamId: row.team_id,
      hackathonId: row.hackathon_id,
      tokenPrefix: row.token_prefix,
      createdByUserId: row.created_by_user_id,
      maxUses: row.max_uses,
      useCount: row.use_count,
      expiresAt:
        row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
      revokedAt:
        row.revoked_at instanceof Date
          ? row.revoked_at.toISOString()
          : row.revoked_at
            ? String(row.revoked_at)
            : null,
      isRevoked,
      isExpired,
      isExhausted,
      createdAt:
        row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    };
  });
}

/**
 * Generates a 256-bit high-entropy invitation code for a team.
 * Persists only the SHA-256 hash (`token_hash`) and short prefix (`token_prefix`).
 * Returns the raw code ONLY at creation time.
 */
export async function createInviteCodeTx(
  client: PoolClient,
  params: {
    teamId: string;
    actorUserId: string;
    expiresInHours?: number;
    expiresAtIso?: string;
    maxUses?: number | null;
    requestId?: string;
  },
): Promise<{ statusCode: number; body: { invite: InviteCodeCreatedDto } }> {
  const team = await lockTeamByIdOrThrow(client, params.teamId);
  await assertTeamLeaderTx(client, team, params.actorUserId);

  // Generate 32 bytes (256 bits) of CSPRNG entropy
  const rawCode = generateOpaqueToken(32);
  const tokenHash = sha256Hex(rawCode);
  const tokenPrefix = rawCode.slice(0, 8);

  let expiresAtDate: Date;
  if (params.expiresAtIso) {
    expiresAtDate = new Date(params.expiresAtIso);
    if (Number.isNaN(expiresAtDate.getTime())) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid expiresAtIso timestamp');
    }
  } else {
    const hours = params.expiresInHours ?? 48;
    expiresAtDate = new Date(Date.now() + hours * 3600 * 1000);
  }

  const maxUses = params.maxUses === undefined ? null : params.maxUses;

  const insertRes = await client.query<InviteCodeRow>(
    `
    INSERT INTO invite_codes (
      team_id,
      hackathon_id,
      token_hash,
      token_prefix,
      created_by_user_id,
      max_uses,
      use_count,
      expires_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, 0, $7::timestamptz)
    RETURNING
      id,
      team_id,
      hackathon_id,
      token_hash,
      token_prefix,
      created_by_user_id,
      max_uses,
      use_count,
      expires_at,
      revoked_at,
      created_at
    `,
    [
      team.id,
      team.hackathon_id,
      tokenHash,
      tokenPrefix,
      params.actorUserId,
      maxUses,
      expiresAtDate.toISOString(),
    ],
  );

  const row = insertRes.rows[0]!;

  // Never store rawCode in audit_log or outbox_events!
  await insertAuditLog(client, {
    hackathonId: team.hackathon_id,
    teamId: team.id,
    actorUserId: params.actorUserId,
    action: 'INVITE_CREATED',
    entityType: 'invite_code',
    entityId: row.id,
    requestId: params.requestId,
    metadata: {
      tokenPrefix: row.token_prefix,
      maxUses: row.max_uses,
      expiresAt:
        row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
    },
  });

  await insertOutboxEvent(client, {
    hackathonId: team.hackathon_id,
    teamId: team.id,
    scope: 'team',
    eventType: 'INVITE_CREATED',
    payload: {
      inviteId: row.id,
      teamId: team.id,
      hackathonId: team.hackathon_id,
      tokenPrefix: row.token_prefix,
      maxUses: row.max_uses,
      expiresAt:
        row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
    },
  });

  return {
    statusCode: 201,
    body: {
      invite: {
        id: row.id,
        teamId: row.team_id,
        hackathonId: row.hackathon_id,
        code: rawCode,
        tokenPrefix: row.token_prefix,
        maxUses: row.max_uses,
        useCount: row.use_count,
        expiresAt:
          row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
        createdAt:
          row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      },
    },
  };
}

/**
 * Leader revokes an invitation code transactionally.
 */
export async function revokeInviteCodeTx(
  client: PoolClient,
  params: {
    teamId: string;
    inviteId: string;
    actorUserId: string;
    requestId?: string;
  },
): Promise<{
  statusCode: number;
  body: { invite: { id: string; teamId: string; revokedAt: string } };
}> {
  if (!UUID_REGEX.test(params.inviteId)) {
    throw new AppError(404, 'NOT_FOUND', 'Invite code not found');
  }

  const team = await lockTeamByIdOrThrow(client, params.teamId);
  await assertTeamLeaderTx(client, team, params.actorUserId);

  const inviteRes = await client.query<InviteCodeRow>(
    `
    SELECT id, team_id, hackathon_id, token_prefix, revoked_at
    FROM invite_codes
    WHERE id = $1 AND team_id = $2
    FOR UPDATE
    `,
    [params.inviteId, team.id],
  );

  const invite = inviteRes.rows[0];
  if (!invite) {
    throw new AppError(404, 'NOT_FOUND', 'Invite code not found for this team');
  }

  const updateRes = await client.query<{ revoked_at: Date }>(
    `
    UPDATE invite_codes
    SET revoked_at = COALESCE(revoked_at, NOW())
    WHERE id = $1
    RETURNING revoked_at
    `,
    [invite.id],
  );
  const revokedAt = updateRes.rows[0]!.revoked_at;
  const revokedAtIso =
    revokedAt instanceof Date ? revokedAt.toISOString() : String(revokedAt);

  await insertAuditLog(client, {
    hackathonId: team.hackathon_id,
    teamId: team.id,
    actorUserId: params.actorUserId,
    action: 'INVITE_REVOKED',
    entityType: 'invite_code',
    entityId: invite.id,
    requestId: params.requestId,
    metadata: {
      tokenPrefix: invite.token_prefix,
      revokedAt: revokedAtIso,
    },
  });

  await insertOutboxEvent(client, {
    hackathonId: team.hackathon_id,
    teamId: team.id,
    scope: 'team',
    eventType: 'INVITE_REVOKED',
    payload: {
      inviteId: invite.id,
      teamId: team.id,
      hackathonId: team.hackathon_id,
      revokedAt: revokedAtIso,
    },
  });

  return {
    statusCode: 200,
    body: {
      invite: {
        id: invite.id,
        teamId: team.id,
        revokedAt: revokedAtIso,
      },
    },
  };
}

/**
 * Redeems an invitation code to create a PENDING join request for leader approval.
 * NEVER directly adds the participant to `team_members`.
 * Enforces `requireActiveHackathonParticipantTx` so unregistered, withdrawn, or disqualified
 * accounts cannot redeem an invitation code.
 */
export async function redeemInviteCodeTx(
  client: PoolClient,
  params: {
    rawCode: string;
    actorUserId: string;
    message?: string;
    requestId?: string;
  },
): Promise<{ statusCode: number; body: InviteRedeemResultDto }> {
  const cleanedCode = params.rawCode.trim();
  if (cleanedCode.length < 16 || cleanedCode.length > 128) {
    throw new AppError(404, 'INVALID_INVITE_CODE', 'Invalid invitation code');
  }

  const tokenHash = sha256Hex(cleanedCode);

  const lookupRes = await client.query<{ id: string; team_id: string }>(
    'SELECT id, team_id FROM invite_codes WHERE token_hash = $1 LIMIT 1',
    [tokenHash],
  );
  const found = lookupRes.rows[0];
  if (!found) {
    throw new AppError(404, 'INVALID_INVITE_CODE', 'Invalid invitation code');
  }

  // Step 3: Lock target team FIRST to maintain consistent global lock ordering
  const team = await lockTeamByIdOrThrow(client, found.team_id);

  // Step 4: Verify hackathon is active and registration deadline (if configured) is open
  await resolveHackathonOrThrow(team.hackathon_id, client, {
    requireRegistrationOpen: true,
  });

  // Step 4b: Verify caller is an active registered participant in this hackathon (locked FOR KEY SHARE)
  await requireActiveHackathonParticipantTx(client, team.hackathon_id, params.actorUserId);

  // Step 5: Lock invite_codes row FOR UPDATE and check validity against PostgreSQL clock
  const inviteRes = await client.query<InviteCodeRow & { is_expired: boolean }>(
    `
    SELECT
      id,
      team_id,
      hackathon_id,
      token_hash,
      token_prefix,
      created_by_user_id,
      max_uses,
      use_count,
      expires_at,
      revoked_at,
      created_at,
      (expires_at <= NOW()) AS is_expired
    FROM invite_codes
    WHERE id = $1
    FOR UPDATE
    `,
    [found.id],
  );

  const invite = inviteRes.rows[0];
  if (!invite) {
    throw new AppError(404, 'INVALID_INVITE_CODE', 'Invalid invitation code');
  }

  if (invite.revoked_at !== null) {
    throw new AppError(410, 'INVITE_REVOKED', 'This invitation code has been revoked');
  }

  if (invite.is_expired) {
    throw new AppError(410, 'INVITE_EXPIRED', 'This invitation code has expired');
  }

  if (invite.max_uses !== null && invite.use_count >= invite.max_uses) {
    throw new AppError(
      409,
      'INVITE_MAX_USES_REACHED',
      'This invitation code has reached its maximum usage limit',
    );
  }

  // Step 6: Verify target team still has capacity
  const countRes = await client.query<{ cnt: number }>(
    'SELECT COUNT(*)::int AS cnt FROM team_members WHERE team_id = $1',
    [team.id],
  );
  const currentCount = countRes.rows[0]?.cnt ?? team.member_count;
  if (currentCount >= team.max_team_size) {
    throw new AppError(
      409,
      'TEAM_FULL',
      `Team has reached its maximum capacity of ${team.max_team_size} members`,
    );
  }

  // Step 7: Verify participant does not already belong to any team in this hackathon
  const existingMembership = await client.query<{ team_id: string }>(
    'SELECT team_id FROM team_members WHERE hackathon_id = $1 AND user_id = $2 LIMIT 1',
    [team.hackathon_id, params.actorUserId],
  );
  if (existingMembership.rows.length > 0) {
    throw new AppError(
      409,
      'ALREADY_IN_TEAM',
      'Participant already belongs to a team in this hackathon',
    );
  }

  // Step 8: Verify participant does not already have a pending join request for this team
  const existingPending = await client.query<{ id: string }>(
    `
    SELECT id
    FROM join_requests
    WHERE team_id = $1 AND user_id = $2 AND status = 'pending'
    LIMIT 1
    `,
    [team.id, params.actorUserId],
  );
  if (existingPending.rows.length > 0) {
    throw new AppError(
      409,
      'JOIN_REQUEST_ALREADY_EXISTS',
      'You already have a pending join request for this team',
    );
  }

  // Step 9: Insert pending join request associated with the invitation code
  let reqRow: JoinRequestRow;
  try {
    const insertReqRes = await client.query<JoinRequestRow>(
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
      VALUES ($1, $2, $3, 'invite_code', $4, $5, 'pending')
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
      [
        team.id,
        team.hackathon_id,
        params.actorUserId,
        invite.id,
        (params.message ?? '').trim(),
      ],
    );
    reqRow = insertReqRes.rows[0]!;
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

  // Step 10: Atomically increment invite use_count only when a new valid pending request is created
  const updatedInvite = await client.query<{ use_count: number }>(
    `
    UPDATE invite_codes
    SET use_count = use_count + 1
    WHERE id = $1
    RETURNING use_count
    `,
    [invite.id],
  );
  const newUseCount = updatedInvite.rows[0]?.use_count ?? invite.use_count + 1;

  // Step 11: Write INVITE_REDEEMED and JOIN_REQUEST_CREATED audit and outbox events
  await insertAuditLog(client, {
    hackathonId: team.hackathon_id,
    teamId: team.id,
    actorUserId: params.actorUserId,
    targetUserId: params.actorUserId,
    action: 'INVITE_REDEEMED',
    entityType: 'invite_code',
    entityId: invite.id,
    requestId: params.requestId,
    metadata: {
      tokenPrefix: invite.token_prefix,
      joinRequestId: reqRow.id,
      useCount: newUseCount,
      maxUses: invite.max_uses,
    },
  });

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
      source: 'invite_code',
      inviteCodeId: invite.id,
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
      source: 'invite_code',
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
