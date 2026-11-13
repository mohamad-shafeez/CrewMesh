import type { Pool, PoolClient } from 'pg';
import {
  computeTeamStatus,
  normalizeSkillTags,
  type HackathonParticipantStatus,
  type PublicMemberSummary,
  type TeamBoardPageResponse,
  type TeamDetailsDto,
  type TeamRole,
  type TeamStatus,
} from '@crewmesh/shared';
import { getDbPool } from '../db/pool.js';
import { AppError } from '../plugins/error-handler.js';
import { insertAuditLog, insertOutboxEvent } from './audit-outbox-service.js';
import { decodeKeysetCursor, encodeKeysetCursor } from './cursor.js';

type Queryable = Pool | PoolClient;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HackathonRow {
  id: string;
  slug: string;
  name: string;
  min_team_size: number;
  max_team_size: number;
  registration_deadline: Date | null;
  is_active: boolean;
  is_past_deadline: boolean;
}

export interface LockedTeamRow {
  id: string;
  hackathon_id: string;
  name: string;
  description: string;
  desired_skills: string[];
  leader_user_id: string;
  status: TeamStatus;
  member_count: number;
  min_team_size: number;
  max_team_size: number;
  looking_for_members: boolean;
  created_at: Date;
  updated_at: Date;
}

interface HydratedMemberRow {
  team_id: string;
  user_id: string;
  display_name: string;
  skills: string[];
  timezone: string | null;
  timezone_confirmed_at: Date | null;
  bio: string;
  role: TeamRole;
  joined_at: Date;
}

/**
 * Resolves a hackathon by UUID or slug.
 * Evaluates optional registration_deadline against PostgreSQL server time (NOW()).
 * When registration_deadline IS NULL, registration remains open with no invented cutoff.
 */
export async function resolveHackathonOrThrow(
  hackathonIdOrSlug: string,
  db: Queryable = getDbPool(),
  options?: { requireRegistrationOpen?: boolean },
): Promise<HackathonRow> {
  const isUuid = UUID_REGEX.test(hackathonIdOrSlug);
  const res = await db.query<HackathonRow>(
    isUuid
      ? `SELECT
           id,
           slug,
           name,
           min_team_size,
           max_team_size,
           registration_deadline,
           is_active,
           (registration_deadline IS NOT NULL AND registration_deadline <= NOW()) AS is_past_deadline
         FROM hackathons WHERE id = $1 LIMIT 1`
      : `SELECT
           id,
           slug,
           name,
           min_team_size,
           max_team_size,
           registration_deadline,
           is_active,
           (registration_deadline IS NOT NULL AND registration_deadline <= NOW()) AS is_past_deadline
         FROM hackathons WHERE slug = $1 LIMIT 1`,
    [hackathonIdOrSlug],
  );

  const row = res.rows[0];
  if (!row) {
    throw new AppError(404, 'HACKATHON_NOT_FOUND', 'Hackathon not found');
  }
  if (!row.is_active) {
    throw new AppError(409, 'HACKATHON_INACTIVE', 'Hackathon is not currently active');
  }
  if (options?.requireRegistrationOpen && row.is_past_deadline) {
    throw new AppError(
      409,
      'HACKATHON_REGISTRATION_CLOSED',
      'Hackathon team formation deadline has passed',
    );
  }
  return row;
}

/**
 * Ensures `userId` is an active registered participant in `hackathonId`.
 * If no row exists yet, registers the participant automatically; if `status` is
 * `'withdrawn'` or `'disqualified'`, rejects with `403 NOT_HACKATHON_PARTICIPANT`.
 */
export async function ensureHackathonParticipantTx(
  client: PoolClient,
  hackathonId: string,
  userId: string,
): Promise<void> {
  const res = await client.query<{ status: HackathonParticipantStatus }>(
    `
    INSERT INTO hackathon_participants (hackathon_id, user_id, status)
    VALUES ($1, $2, 'registered')
    ON CONFLICT (hackathon_id, user_id) DO UPDATE SET
      status = hackathon_participants.status
    RETURNING status
    `,
    [hackathonId, userId],
  );

  const status = res.rows[0]?.status;
  if (status && status !== 'registered') {
    throw new AppError(
      403,
      'NOT_HACKATHON_PARTICIPANT',
      `User is not an active participant in this hackathon (status: ${status})`,
    );
  }
}

/**
 * Locks a team row with `SELECT ... FOR UPDATE` and verifies it exists.
 */
export async function lockTeamByIdOrThrow(
  client: PoolClient,
  teamId: string,
): Promise<LockedTeamRow> {
  if (!UUID_REGEX.test(teamId)) {
    throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found');
  }

  const res = await client.query<LockedTeamRow>(
    `
    SELECT
      id,
      hackathon_id,
      name,
      description,
      desired_skills,
      leader_user_id,
      status,
      member_count,
      min_team_size,
      max_team_size,
      looking_for_members,
      created_at,
      updated_at
    FROM teams
    WHERE id = $1
    FOR UPDATE
    `,
    [teamId],
  );

  const row = res.rows[0];
  if (!row) {
    throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found');
  }
  return row;
}

/**
 * Verifies that `actorUserId` is the current leader of the locked team in both `teams` and `team_members`.
 */
export async function assertTeamLeaderTx(
  client: PoolClient,
  team: LockedTeamRow,
  actorUserId: string,
): Promise<void> {
  if (team.leader_user_id !== actorUserId) {
    throw new AppError(
      403,
      'UNAUTHORIZED_TEAM_ACTION',
      'Only the current team leader can perform this action',
    );
  }

  const leaderCheck = await client.query<{ id: string }>(
    `
    SELECT id
    FROM team_members
    WHERE team_id = $1 AND user_id = $2 AND role = 'leader'
    LIMIT 1
    `,
    [team.id, actorUserId],
  );

  if (leaderCheck.rows.length === 0) {
    throw new AppError(
      403,
      'UNAUTHORIZED_TEAM_ACTION',
      'Only the current team leader can perform this action',
    );
  }
}

/**
 * Batch-hydrates a list of team rows with their active members in a single query (zero N+1 queries).
 * Exposes `timezone` ONLY when `timezone_confirmed_at IS NOT NULL` (never fabricating UTC).
 */
export async function hydrateTeamRows(
  teamRows: LockedTeamRow[],
  db: Queryable = getDbPool(),
): Promise<TeamDetailsDto[]> {
  if (teamRows.length === 0) {
    return [];
  }

  const teamIds = teamRows.map((t) => t.id);
  const membersRes = await db.query<HydratedMemberRow>(
    `
    SELECT
      tm.team_id,
      tm.user_id,
      u.display_name,
      u.skills,
      u.timezone,
      u.timezone_confirmed_at,
      u.bio,
      tm.role,
      tm.joined_at
    FROM team_members tm
    INNER JOIN users u ON u.id = tm.user_id
    WHERE tm.team_id = ANY($1::uuid[])
    ORDER BY
      tm.team_id ASC,
      CASE WHEN tm.role = 'leader' THEN 0 ELSE 1 END ASC,
      tm.joined_at ASC,
      tm.user_id ASC
    `,
    [teamIds],
  );

  const membersByTeamId = new Map<string, PublicMemberSummary[]>();
  for (const row of membersRes.rows) {
    const list = membersByTeamId.get(row.team_id) ?? [];
    list.push({
      userId: row.user_id,
      displayName: row.display_name,
      skills: Array.isArray(row.skills) ? row.skills : [],
      timezone: row.timezone_confirmed_at !== null ? row.timezone : null,
      bio: row.bio,
      role: row.role,
      joinedAt:
        row.joined_at instanceof Date ? row.joined_at.toISOString() : String(row.joined_at),
    });
    membersByTeamId.set(row.team_id, list);
  }

  return teamRows.map((team) => {
    const members = membersByTeamId.get(team.id) ?? [];
    const actualCount = members.length > 0 ? members.length : team.member_count;
    const leader =
      members.find((m) => m.role === 'leader') ??
      members.find((m) => m.userId === team.leader_user_id) ?? {
        userId: team.leader_user_id,
        displayName: 'Team Leader',
        skills: [],
        timezone: null,
        bio: '',
        role: 'leader' as const,
        joinedAt:
          team.created_at instanceof Date
            ? team.created_at.toISOString()
            : String(team.created_at),
      };

    const status = computeTeamStatus(actualCount, team.min_team_size);
    const isFull = actualCount >= team.max_team_size;
    const availableSeats = Math.max(0, team.max_team_size - actualCount);

    return {
      id: team.id,
      hackathonId: team.hackathon_id,
      name: team.name,
      description: team.description,
      desiredSkills: Array.isArray(team.desired_skills) ? team.desired_skills : [],
      leaderUserId: team.leader_user_id,
      leader,
      status,
      isFull,
      memberCount: actualCount,
      minTeamSize: team.min_team_size,
      maxTeamSize: team.max_team_size,
      availableSeats,
      lookingForMembers: !isFull && team.looking_for_members,
      members,
      createdAt:
        team.created_at instanceof Date ? team.created_at.toISOString() : String(team.created_at),
      updatedAt:
        team.updated_at instanceof Date ? team.updated_at.toISOString() : String(team.updated_at),
    };
  });
}

/**
 * Retrieves a single hydrated team by ID or throws 404 TEAM_NOT_FOUND.
 */
export async function getTeamByIdOrThrow(
  teamId: string,
  db: Queryable = getDbPool(),
): Promise<TeamDetailsDto> {
  if (!UUID_REGEX.test(teamId)) {
    throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found');
  }

  const res = await db.query<LockedTeamRow>(
    `
    SELECT
      id,
      hackathon_id,
      name,
      description,
      desired_skills,
      leader_user_id,
      status,
      member_count,
      min_team_size,
      max_team_size,
      looking_for_members,
      created_at,
      updated_at
    FROM teams
    WHERE id = $1
    LIMIT 1
    `,
    [teamId],
  );

  const row = res.rows[0];
  if (!row) {
    throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found');
  }

  const hydrated = await hydrateTeamRows([row], db);
  return hydrated[0]!;
}

/**
 * Queries the public team board with keyset/cursor pagination and filters (no N+1 queries).
 */
export async function listTeamBoard(
  params: {
    hackathonIdOrSlug: string;
    cursor?: string;
    limit?: number;
    status?: TeamStatus;
    hasCapacity?: boolean;
    lookingForMembers?: boolean;
    skill?: string;
    search?: string;
  },
  db: Queryable = getDbPool(),
): Promise<TeamBoardPageResponse> {
  const hackathon = await resolveHackathonOrThrow(params.hackathonIdOrSlug, db);
  const pageSize = Math.min(Math.max(params.limit ?? 20, 1), 50);

  const conditions: string[] = ['t.hackathon_id = $1'];
  const values: unknown[] = [hackathon.id];

  if (params.status) {
    values.push(params.status);
    conditions.push(`t.status = $${values.length}`);
  }

  if (params.hasCapacity === true) {
    conditions.push('t.member_count < t.max_team_size');
  } else if (params.hasCapacity === false) {
    conditions.push('t.member_count >= t.max_team_size');
  }

  if (params.lookingForMembers !== undefined) {
    values.push(params.lookingForMembers);
    conditions.push(`t.looking_for_members = $${values.length}`);
  }

  if (params.skill && params.skill.trim().length > 0) {
    const normalizedSkill = normalizeSkillTags([params.skill])[0];
    if (normalizedSkill) {
      values.push([normalizedSkill]);
      conditions.push(`t.desired_skills @> $${values.length}::text[]`);
    }
  }

  if (params.search && params.search.trim().length > 0) {
    values.push(`%${params.search.trim()}%`);
    conditions.push(`(t.name ILIKE $${values.length} OR t.description ILIKE $${values.length})`);
  }

  if (params.cursor) {
    const decoded = decodeKeysetCursor(params.cursor);
    values.push(decoded.createdAt, decoded.id);
    const createdIdx = values.length - 1;
    const idIdx = values.length;
    conditions.push(
      `(t.created_at, t.id) < ($${createdIdx}::timestamptz, $${idIdx}::uuid)`,
    );
  }

  values.push(pageSize + 1);
  const limitIdx = values.length;

  const teamsRes = await db.query<LockedTeamRow>(
    `
    SELECT
      t.id,
      t.hackathon_id,
      t.name,
      t.description,
      t.desired_skills,
      t.leader_user_id,
      t.status,
      t.member_count,
      t.min_team_size,
      t.max_team_size,
      t.looking_for_members,
      t.created_at,
      t.updated_at
    FROM teams t
    WHERE ${conditions.join(' AND ')}
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT $${limitIdx}
    `,
    values,
  );

  const hasMore = teamsRes.rows.length > pageSize;
  const slice = hasMore ? teamsRes.rows.slice(0, pageSize) : teamsRes.rows;
  const items = await hydrateTeamRows(slice, db);

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
 * Shared serialized membership engine: adds `candidateUserId` to an already row-locked `team`
 * inside `client` transaction, verifying capacity from actual `team_members` rows and enforcing
 * the unique `(hackathon_id, user_id)` invariant.
 */
export async function addMemberToLockedTeamTx(
  client: PoolClient,
  params: {
    team: LockedTeamRow;
    candidateUserId: string;
    actorUserId: string;
    requestId?: string;
    sourceAuditAction?: 'JOIN_REQUEST_ACCEPTED';
    sourceEntityId?: string;
    sourceMetadata?: Record<string, unknown>;
  },
): Promise<{ memberCount: number; status: TeamStatus }> {
  const { team, candidateUserId } = params;

  await ensureHackathonParticipantTx(client, team.hackathon_id, candidateUserId);

  const countRes = await client.query<{ cnt: number }>(
    'SELECT COUNT(*)::int AS cnt FROM team_members WHERE team_id = $1',
    [team.id],
  );
  const currentCount = countRes.rows[0]?.cnt ?? 0;

  if (currentCount >= team.max_team_size) {
    throw new AppError(
      409,
      'TEAM_FULL',
      `Team has reached its maximum capacity of ${team.max_team_size} members`,
    );
  }

  const existingMembership = await client.query<{ team_id: string }>(
    'SELECT team_id FROM team_members WHERE hackathon_id = $1 AND user_id = $2 LIMIT 1',
    [team.hackathon_id, candidateUserId],
  );
  if (existingMembership.rows.length > 0) {
    throw new AppError(
      409,
      'ALREADY_IN_TEAM',
      'Participant already belongs to a team in this hackathon',
    );
  }

  let memberRowId: string;
  try {
    const insertRes = await client.query<{ id: string }>(
      `
      INSERT INTO team_members (team_id, hackathon_id, user_id, role)
      VALUES ($1, $2, $3, 'member')
      RETURNING id
      `,
      [team.id, team.hackathon_id, candidateUserId],
    );
    memberRowId = insertRes.rows[0]!.id;
  } catch (err) {
    const pgErr = err as { code?: string; constraint?: string };
    if (
      pgErr.code === '23505' &&
      (pgErr.constraint === 'team_members_one_team_per_hackathon_unique' ||
        pgErr.constraint === 'team_members_team_user_unique')
    ) {
      throw new AppError(
        409,
        'ALREADY_IN_TEAM',
        'Participant already belongs to a team in this hackathon',
      );
    }
    throw err;
  }

  const newCount = currentCount + 1;
  const newStatus = computeTeamStatus(newCount, team.min_team_size);
  const newLooking = newCount >= team.max_team_size ? false : team.looking_for_members;

  await client.query(
    `
    UPDATE teams
    SET
      member_count = $2,
      status = $3,
      looking_for_members = $4,
      updated_at = NOW()
    WHERE id = $1
    `,
    [team.id, newCount, newStatus, newLooking],
  );

  await insertAuditLog(client, {
    hackathonId: team.hackathon_id,
    teamId: team.id,
    actorUserId: params.actorUserId,
    targetUserId: candidateUserId,
    action: 'MEMBER_ADDED',
    entityType: 'team_member',
    entityId: memberRowId,
    requestId: params.requestId,
    metadata: {
      memberCount: newCount,
      maxTeamSize: team.max_team_size,
      status: newStatus,
      ...(params.sourceMetadata ?? {}),
    },
  });

  await insertOutboxEvent(client, {
    hackathonId: team.hackathon_id,
    teamId: team.id,
    scope: 'both',
    eventType: 'MEMBER_JOINED',
    payload: {
      teamId: team.id,
      hackathonId: team.hackathon_id,
      userId: candidateUserId,
      memberCount: newCount,
      minTeamSize: team.min_team_size,
      maxTeamSize: team.max_team_size,
      status: newStatus,
      isFull: newCount >= team.max_team_size,
    },
  });

  return { memberCount: newCount, status: newStatus };
}

/**
 * Creates a new team and inserts its creator as the initial leader in one transaction.
 */
export async function createTeamTx(
  client: PoolClient,
  params: {
    hackathonIdOrSlug: string;
    actorUserId: string;
    name: string;
    description?: string;
    desiredSkills?: string[];
    lookingForMembers?: boolean;
    minTeamSizeOverride?: number;
    maxTeamSizeOverride?: number;
    requestId?: string;
  },
): Promise<{ statusCode: number; body: { team: TeamDetailsDto } }> {
  const hackathon = await resolveHackathonOrThrow(params.hackathonIdOrSlug, client, {
    requireRegistrationOpen: true,
  });

  await ensureHackathonParticipantTx(client, hackathon.id, params.actorUserId);

  const minSize = params.minTeamSizeOverride ?? hackathon.min_team_size;
  const maxSize = params.maxTeamSizeOverride ?? hackathon.max_team_size;

  if (
    minSize < 1 ||
    maxSize < minSize ||
    maxSize > hackathon.max_team_size ||
    minSize < hackathon.min_team_size
  ) {
    throw new AppError(
      400,
      'INVALID_TEAM_SIZE',
      `Team size bounds must fall within hackathon limits (${hackathon.min_team_size}–${hackathon.max_team_size})`,
    );
  }

  const existingMember = await client.query<{ team_id: string }>(
    'SELECT team_id FROM team_members WHERE hackathon_id = $1 AND user_id = $2 LIMIT 1',
    [hackathon.id, params.actorUserId],
  );
  if (existingMember.rows.length > 0) {
    throw new AppError(
      409,
      'ALREADY_IN_TEAM',
      'You already belong to a team in this hackathon',
    );
  }

  const trimmedName = params.name.trim();
  const trimmedDesc = (params.description ?? '').trim();
  const normalizedSkills = normalizeSkillTags(params.desiredSkills ?? []);
  const initialCount = 1;
  const initialStatus = computeTeamStatus(initialCount, minSize);
  const isAlreadyFull = initialCount >= maxSize;
  const lookingForMembers = isAlreadyFull ? false : (params.lookingForMembers ?? true);

  let teamRow: LockedTeamRow;
  try {
    const teamRes = await client.query<LockedTeamRow>(
      `
      INSERT INTO teams (
        hackathon_id,
        name,
        description,
        desired_skills,
        leader_user_id,
        status,
        member_count,
        min_team_size,
        max_team_size,
        looking_for_members
      )
      VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9)
      RETURNING
        id,
        hackathon_id,
        name,
        description,
        desired_skills,
        leader_user_id,
        status,
        member_count,
        min_team_size,
        max_team_size,
        looking_for_members,
        created_at,
        updated_at
      `,
      [
        hackathon.id,
        trimmedName,
        trimmedDesc,
        normalizedSkills,
        params.actorUserId,
        initialStatus,
        minSize,
        maxSize,
        lookingForMembers,
      ],
    );
    teamRow = teamRes.rows[0]!;

    await client.query(
      `
      INSERT INTO team_members (team_id, hackathon_id, user_id, role)
      VALUES ($1, $2, $3, 'leader')
      `,
      [teamRow.id, hackathon.id, params.actorUserId],
    );
  } catch (err) {
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === '23505') {
      if (pgErr.constraint === 'teams_hackathon_name_unique') {
        throw new AppError(
          409,
          'TEAM_NAME_ALREADY_EXISTS',
          'A team with this name already exists in this hackathon',
        );
      }
      if (pgErr.constraint === 'team_members_one_team_per_hackathon_unique') {
        throw new AppError(
          409,
          'ALREADY_IN_TEAM',
          'You already belong to a team in this hackathon',
        );
      }
    }
    throw err;
  }

  await insertAuditLog(client, {
    hackathonId: hackathon.id,
    teamId: teamRow.id,
    actorUserId: params.actorUserId,
    targetUserId: params.actorUserId,
    action: 'TEAM_CREATED',
    entityType: 'team',
    entityId: teamRow.id,
    requestId: params.requestId,
    metadata: {
      name: teamRow.name,
      status: teamRow.status,
      memberCount: 1,
      minTeamSize: minSize,
      maxTeamSize: maxSize,
    },
  });

  await insertOutboxEvent(client, {
    hackathonId: hackathon.id,
    teamId: teamRow.id,
    scope: 'both',
    eventType: 'TEAM_CREATED',
    payload: {
      teamId: teamRow.id,
      hackathonId: hackathon.id,
      name: teamRow.name,
      leaderUserId: params.actorUserId,
      status: teamRow.status,
      memberCount: 1,
      minTeamSize: minSize,
      maxTeamSize: maxSize,
      isFull: isAlreadyFull,
    },
  });

  const hydrated = await hydrateTeamRows([teamRow], client);
  return {
    statusCode: 201,
    body: { team: hydrated[0]! },
  };
}

/**
 * Leader updates team desired skill preferences and optional recruiting toggle transactionally.
 * Persists changes in PostgreSQL, records an audit entry, and writes a transactional outbox event.
 */
export async function updateTeamPreferencesTx(
  client: PoolClient,
  params: {
    teamId: string;
    actorUserId: string;
    desiredSkills: string[];
    lookingForMembers?: boolean;
    requestId?: string;
  },
): Promise<{ statusCode: number; body: { team: TeamDetailsDto } }> {
  const team = await lockTeamByIdOrThrow(client, params.teamId);
  await assertTeamLeaderTx(client, team, params.actorUserId);

  const normalizedSkills = normalizeSkillTags(params.desiredSkills);
  const countRes = await client.query<{ cnt: number }>(
    'SELECT COUNT(*)::int AS cnt FROM team_members WHERE team_id = $1',
    [team.id],
  );
  const actualCount = countRes.rows[0]?.cnt ?? team.member_count;
  const isFull = actualCount >= team.max_team_size;

  const nextLooking = isFull
    ? false
    : params.lookingForMembers !== undefined
      ? params.lookingForMembers
      : team.looking_for_members;

  const updatedTeamRes = await client.query<LockedTeamRow>(
    `
    UPDATE teams
    SET
      desired_skills = $2,
      looking_for_members = $3,
      updated_at = NOW()
    WHERE id = $1
    RETURNING
      id,
      hackathon_id,
      name,
      description,
      desired_skills,
      leader_user_id,
      status,
      member_count,
      min_team_size,
      max_team_size,
      looking_for_members,
      created_at,
      updated_at
    `,
    [team.id, normalizedSkills, nextLooking],
  );

  const updatedTeam = updatedTeamRes.rows[0]!;

  await insertAuditLog(client, {
    hackathonId: team.hackathon_id,
    teamId: team.id,
    actorUserId: params.actorUserId,
    action: 'TEAM_PREFERENCES_UPDATED',
    entityType: 'team',
    entityId: team.id,
    requestId: params.requestId,
    metadata: {
      desiredSkills: normalizedSkills,
      lookingForMembers: nextLooking,
    },
  });

  await insertOutboxEvent(client, {
    hackathonId: team.hackathon_id,
    teamId: team.id,
    scope: 'both',
    eventType: 'TEAM_PREFERENCES_UPDATED',
    payload: {
      teamId: team.id,
      hackathonId: team.hackathon_id,
      desiredSkills: normalizedSkills,
      lookingForMembers: nextLooking,
      memberCount: actualCount,
      minTeamSize: team.min_team_size,
      maxTeamSize: team.max_team_size,
      status: updatedTeam.status,
      isFull,
    },
  });

  const hydrated = await hydrateTeamRows([updatedTeam], client);
  return {
    statusCode: 200,
    body: { team: hydrated[0]! },
  };
}

/**
 * Leader removes another team member transactionally.
 * Leader is forbidden from removing themselves here; they must use leaveTeamTx.
 */
export async function removeMemberTx(
  client: PoolClient,
  params: {
    teamId: string;
    actorUserId: string;
    targetUserId: string;
    requestId?: string;
  },
): Promise<{ statusCode: number; body: { team: TeamDetailsDto } }> {
  const team = await lockTeamByIdOrThrow(client, params.teamId);
  await assertTeamLeaderTx(client, team, params.actorUserId);

  if (params.targetUserId === params.actorUserId) {
    throw new AppError(
      409,
      'LEADER_MUST_USE_LEAVE',
      'Team leader cannot remove themselves via member removal; use the leave team endpoint instead',
    );
  }

  const memberRes = await client.query<{ id: string; role: TeamRole }>(
    `
    SELECT id, role
    FROM team_members
    WHERE team_id = $1 AND user_id = $2
    FOR UPDATE
    `,
    [team.id, params.targetUserId],
  );

  const memberRow = memberRes.rows[0];
  if (!memberRow) {
    throw new AppError(404, 'MEMBER_NOT_FOUND', 'Target user is not a member of this team');
  }

  await client.query('DELETE FROM team_members WHERE id = $1', [memberRow.id]);

  const countRes = await client.query<{ cnt: number }>(
    'SELECT COUNT(*)::int AS cnt FROM team_members WHERE team_id = $1',
    [team.id],
  );
  const newCount = countRes.rows[0]?.cnt ?? 1;
  const newStatus = computeTeamStatus(newCount, team.min_team_size);

  const updatedTeamRes = await client.query<LockedTeamRow>(
    `
    UPDATE teams
    SET
      member_count = $2,
      status = $3,
      updated_at = NOW()
    WHERE id = $1
    RETURNING
      id,
      hackathon_id,
      name,
      description,
      desired_skills,
      leader_user_id,
      status,
      member_count,
      min_team_size,
      max_team_size,
      looking_for_members,
      created_at,
      updated_at
    `,
    [team.id, newCount, newStatus],
  );
  const updatedTeam = updatedTeamRes.rows[0]!;

  await insertAuditLog(client, {
    hackathonId: team.hackathon_id,
    teamId: team.id,
    actorUserId: params.actorUserId,
    targetUserId: params.targetUserId,
    action: 'MEMBER_REMOVED',
    entityType: 'team_member',
    entityId: memberRow.id,
    requestId: params.requestId,
    metadata: {
      removedUserId: params.targetUserId,
      memberCount: newCount,
      status: newStatus,
    },
  });

  await insertOutboxEvent(client, {
    hackathonId: team.hackathon_id,
    teamId: team.id,
    scope: 'both',
    eventType: 'MEMBER_REMOVED',
    payload: {
      teamId: team.id,
      hackathonId: team.hackathon_id,
      removedUserId: params.targetUserId,
      memberCount: newCount,
      minTeamSize: team.min_team_size,
      maxTeamSize: team.max_team_size,
      status: newStatus,
      isFull: newCount >= team.max_team_size,
    },
  });

  const hydrated = await hydrateTeamRows([updatedTeam], client);
  return {
    statusCode: 200,
    body: { team: hydrated[0]! },
  };
}

export interface LeaveTeamResultDto {
  teamDeleted: boolean;
  teamId: string;
  newLeaderUserId: string | null;
  team: TeamDetailsDto | null;
}

/**
 * Member or leader leaves the team transactionally:
 * - If the departing member is the LAST member (`COUNT(*) == 1`), deletes the team row
 *   (while preserving `audit_log` and `outbox_events` with `TEAM_DELETED`).
 * - If the departing member is the leader and other members remain, deterministically
 *   promotes the earliest-joined remaining member (`ORDER BY joined_at ASC, user_id ASC`)
 *   to `'leader'` in the same transaction (`LEADER_SUCCESSION`).
 */
export async function leaveTeamTx(
  client: PoolClient,
  params: {
    teamId: string;
    actorUserId: string;
    requestId?: string;
  },
): Promise<{ statusCode: number; body: LeaveTeamResultDto }> {
  const team = await lockTeamByIdOrThrow(client, params.teamId);

  const membersRes = await client.query<{
    id: string;
    user_id: string;
    role: TeamRole;
    joined_at: Date;
  }>(
    `
    SELECT id, user_id, role, joined_at
    FROM team_members
    WHERE team_id = $1
    ORDER BY joined_at ASC, user_id ASC
    FOR UPDATE
    `,
    [team.id],
  );

  const callerMember = membersRes.rows.find((m) => m.user_id === params.actorUserId);
  if (!callerMember) {
    throw new AppError(403, 'NOT_A_TEAM_MEMBER', 'You are not a member of this team');
  }

  if (membersRes.rows.length === 1) {
    // Last member leaving: delete the team (cascade deletes team_members, join_requests, invite_codes)
    await client.query('DELETE FROM teams WHERE id = $1', [team.id]);

    await insertAuditLog(client, {
      hackathonId: team.hackathon_id,
      teamId: team.id,
      actorUserId: params.actorUserId,
      targetUserId: params.actorUserId,
      action: 'MEMBER_LEFT',
      entityType: 'team_member',
      entityId: callerMember.id,
      requestId: params.requestId,
      metadata: {
        lastMember: true,
      },
    });

    await insertAuditLog(client, {
      hackathonId: team.hackathon_id,
      teamId: team.id,
      actorUserId: params.actorUserId,
      action: 'TEAM_DELETED',
      entityType: 'team',
      entityId: team.id,
      requestId: params.requestId,
      metadata: {
        reason: 'last_member_left',
        teamName: team.name,
      },
    });

    await insertOutboxEvent(client, {
      hackathonId: team.hackathon_id,
      teamId: team.id,
      scope: 'both',
      eventType: 'TEAM_DELETED',
      payload: {
        teamId: team.id,
        hackathonId: team.hackathon_id,
        actorUserId: params.actorUserId,
        reason: 'last_member_left',
      },
    });

    return {
      statusCode: 200,
      body: {
        teamDeleted: true,
        teamId: team.id,
        newLeaderUserId: null,
        team: null,
      },
    };
  }

  await client.query('DELETE FROM team_members WHERE id = $1', [callerMember.id]);

  const remainingMembers = membersRes.rows.filter((m) => m.user_id !== params.actorUserId);
  const newCount = remainingMembers.length;
  const newStatus = computeTeamStatus(newCount, team.min_team_size);
  let newLeaderUserId = team.leader_user_id;

  if (callerMember.role === 'leader') {
    const successor = remainingMembers[0]!;
    newLeaderUserId = successor.user_id;

    await client.query(
      "UPDATE team_members SET role = 'leader' WHERE id = $1",
      [successor.id],
    );
  }

  const updatedTeamRes = await client.query<LockedTeamRow>(
    `
    UPDATE teams
    SET
      leader_user_id = $2,
      member_count = $3,
      status = $4,
      updated_at = NOW()
    WHERE id = $1
    RETURNING
      id,
      hackathon_id,
      name,
      description,
      desired_skills,
      leader_user_id,
      status,
      member_count,
      min_team_size,
      max_team_size,
      looking_for_members,
      created_at,
      updated_at
    `,
    [team.id, newLeaderUserId, newCount, newStatus],
  );
  const updatedTeam = updatedTeamRes.rows[0]!;

  await insertAuditLog(client, {
    hackathonId: team.hackathon_id,
    teamId: team.id,
    actorUserId: params.actorUserId,
    targetUserId: params.actorUserId,
    action: 'MEMBER_LEFT',
    entityType: 'team_member',
    entityId: callerMember.id,
    requestId: params.requestId,
    metadata: {
      wasLeader: callerMember.role === 'leader',
      memberCount: newCount,
      status: newStatus,
    },
  });

  if (callerMember.role === 'leader') {
    await insertAuditLog(client, {
      hackathonId: team.hackathon_id,
      teamId: team.id,
      actorUserId: params.actorUserId,
      targetUserId: newLeaderUserId,
      action: 'LEADER_SUCCESSION',
      entityType: 'team',
      entityId: team.id,
      requestId: params.requestId,
      metadata: {
        previousLeaderUserId: params.actorUserId,
        newLeaderUserId,
        memberCount: newCount,
      },
    });

    await insertOutboxEvent(client, {
      hackathonId: team.hackathon_id,
      teamId: team.id,
      scope: 'both',
      eventType: 'LEADER_SUCCESSION',
      payload: {
        teamId: team.id,
        hackathonId: team.hackathon_id,
        previousLeaderUserId: params.actorUserId,
        newLeaderUserId,
        memberCount: newCount,
        minTeamSize: team.min_team_size,
        maxTeamSize: team.max_team_size,
        status: newStatus,
        isFull: newCount >= team.max_team_size,
      },
    });
  } else {
    await insertOutboxEvent(client, {
      hackathonId: team.hackathon_id,
      teamId: team.id,
      scope: 'both',
      eventType: 'MEMBER_LEFT',
      payload: {
        teamId: team.id,
        hackathonId: team.hackathon_id,
        departedUserId: params.actorUserId,
        memberCount: newCount,
        minTeamSize: team.min_team_size,
        maxTeamSize: team.max_team_size,
        status: newStatus,
        isFull: newCount >= team.max_team_size,
      },
    });
  }

  const hydrated = await hydrateTeamRows([updatedTeam], client);
  return {
    statusCode: 200,
    body: {
      teamDeleted: false,
      teamId: team.id,
      newLeaderUserId,
      team: hydrated[0]!,
    },
  };
}
