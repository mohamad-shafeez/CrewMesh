import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { closeDbPool, getDbPool, withTransaction } from './pool.js';
import { seedHackathon } from './seed.js';
import { hashPassword } from '../security/crypto.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SCALE_TOTAL_PARTICIPANTS = 10_000;
export const SCALE_TOTAL_TEAMS = 2_000;
export const SCALE_TOTAL_MEMBERSHIPS = 7_000;
export const SCALE_UNASSIGNED_PARTICIPANTS = 3_000;

export const SCALE_TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Asia/Dubai',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'Asia/Singapore',
  'Australia/Sydney',
  'UTC',
] as const;

export const SCALE_SKILL_POOL = [
  'typescript',
  'postgresql',
  'react',
  'node.js',
  'rust',
  'go',
  'python',
  'docker',
  'kubernetes',
  'redis',
  'graphql',
  'nextjs',
  'tailwindcss',
  'aws',
  'terraform',
  'solidity',
  'pytorch',
  'fastapi',
  'svelte',
  'wasm',
] as const;

export interface ScaleParticipantRecord {
  id: string;
  index: number;
  email: string;
  displayName: string;
  skills: string[];
  timezone: string;
  timezoneConfirmedAt: string;
  bio: string;
  createdAt: string;
}

export interface ScaleTeamRecord {
  id: string;
  index: number;
  hackathonId: string;
  name: string;
  description: string;
  desiredSkills: string[];
  leaderUserId: string;
  status: 'ready';
  memberCount: number;
  minTeamSize: number;
  maxTeamSize: number;
  lookingForMembers: boolean;
  createdAt: string;
}

export interface ScaleMembershipRecord {
  id: string;
  teamId: string;
  hackathonId: string;
  userId: string;
  role: 'leader' | 'member';
  joinedAt: string;
}

export interface ScaleDatabaseCountsSnapshot {
  databaseName: string;
  hackathonId: string;
  capturedAt: string;
  participantsCount: number;
  hackathonEligibleParticipantsCount: number;
  teamsCount: number;
  membershipsCount: number;
  teamSizeDistribution: Record<string, number>;
  unassignedParticipantsCount: number;
  fullTeamsCount: number;
  openCapacityTeamsCount: number;
  incorrectMemberCounterTeamsCount: number;
  incorrectLeaderCountTeamsCount: number;
  duplicateTeamMembershipUsersCount: number;
}

/**
 * Generates a deterministic UUID for scale benchmark entities.
 * Namespace 4000 = users, 4001 = teams, 4002 = team_members, 4003 = hackathon_participants.
 */
export function makeDeterministicScaleUuid(
  entityKind: 'user' | 'team' | 'member' | 'participant',
  oneBasedIndex: number,
): string {
  const kindSegment =
    entityKind === 'user'
      ? '4000'
      : entityKind === 'team'
        ? '4001'
        : entityKind === 'member'
          ? '4002'
          : '4003';
  const suffix = String(oneBasedIndex).padStart(12, '0');
  return `00000000-0006-${kindSegment}-8000-${suffix}`;
}

/**
 * Deterministically generates all 10,000 participant records, 2,000 teams,
 * and 7,000 team_members records in memory (pure function, testable without DB).
 */
export function buildDeterministicScaleDataset(hackathonId: string): {
  participants: ScaleParticipantRecord[];
  teams: ScaleTeamRecord[];
  memberships: ScaleMembershipRecord[];
} {
  const baseEpochMs = Date.UTC(2026, 10, 1, 0, 0, 0); // 2026-11-01T00:00:00.000Z
  const confirmedAtIso = new Date(baseEpochMs).toISOString();

  const participants: ScaleParticipantRecord[] = new Array(SCALE_TOTAL_PARTICIPANTS);
  const skillCountPool = SCALE_SKILL_POOL.length;
  const tzCountPool = SCALE_TIMEZONES.length;

  for (let i = 1; i <= SCALE_TOTAL_PARTICIPANTS; i++) {
    const padded = String(i).padStart(5, '0');
    const numSkills = 2 + (i % 3); // 2, 3, or 4 skills per participant
    const skills: string[] = [];
    for (let s = 0; s < numSkills; s++) {
      const skillIdx = (i * 7 + s * 5) % skillCountPool;
      const tag = SCALE_SKILL_POOL[skillIdx]!;
      if (!skills.includes(tag)) {
        skills.push(tag);
      }
    }

    const tz = SCALE_TIMEZONES[(i - 1) % tzCountPool]!;
    const createdAtIso = new Date(baseEpochMs + i * 1_000).toISOString();

    participants[i - 1] = {
      id: makeDeterministicScaleUuid('user', i),
      index: i,
      email: `loadtest-${padded}@crewmesh.invalid`,
      displayName: `LoadTest Participant ${padded}`,
      skills,
      timezone: tz,
      timezoneConfirmedAt: confirmedAtIso,
      bio: `Deterministic benchmark participant #${padded} (${tz}).`,
      createdAt: createdAtIso,
    };
  }

  const teams: ScaleTeamRecord[] = new Array(SCALE_TOTAL_TEAMS);
  const memberships: ScaleMembershipRecord[] = new Array(SCALE_TOTAL_MEMBERSHIPS);

  let nextParticipantZeroIdx = 0;
  let nextMembershipOneIdx = 1;

  // Exact team-size distribution required by Batch 06 Section 5.A:
  // - Teams 1..500: size 2 (1,000 memberships)
  // - Teams 501..1000: size 3 (1,500 memberships)
  // - Teams 1001..1500: size 4 (2,000 memberships)
  // - Teams 1501..2000: size 5 (2,500 memberships)
  for (let t = 1; t <= SCALE_TOTAL_TEAMS; t++) {
    const paddedTeam = String(t).padStart(4, '0');
    const teamSize = t <= 500 ? 2 : t <= 1000 ? 3 : t <= 1500 ? 4 : 5;
    const isFull = teamSize >= 5;
    const teamId = makeDeterministicScaleUuid('team', t);
    const teamCreatedAtMs = baseEpochMs + 20_000_000 + t * 2_000;
    const teamCreatedAtIso = new Date(teamCreatedAtMs).toISOString();

    const teamMemberParticipants: ScaleParticipantRecord[] = [];
    for (let m = 0; m < teamSize; m++) {
      const p = participants[nextParticipantZeroIdx]!;
      nextParticipantZeroIdx += 1;
      teamMemberParticipants.push(p);

      memberships[nextMembershipOneIdx - 1] = {
        id: makeDeterministicScaleUuid('member', nextMembershipOneIdx),
        teamId,
        hackathonId,
        userId: p.id,
        role: m === 0 ? 'leader' : 'member',
        joinedAt: new Date(teamCreatedAtMs + m * 100).toISOString(),
      };
      nextMembershipOneIdx += 1;
    }

    const leader = teamMemberParticipants[0]!;
    const memberSkillsUnion = new Set<string>();
    for (const mp of teamMemberParticipants) {
      for (const sk of mp.skills) {
        memberSkillsUnion.add(sk);
      }
    }

    // Build desired_skills: 2 covered skills from leader + 2 unmet skills not in memberSkillsUnion
    // so recommendation queries against open-capacity teams always have realistic unmet desired skills.
    const desiredSkills: string[] = [];
    for (const sk of leader.skills.slice(0, 2)) {
      if (!desiredSkills.includes(sk)) {
        desiredSkills.push(sk);
      }
    }
    for (let offset = 0; offset < skillCountPool && desiredSkills.length < 4; offset++) {
      const candidateSkill = SCALE_SKILL_POOL[(t * 3 + offset) % skillCountPool]!;
      if (!memberSkillsUnion.has(candidateSkill) && !desiredSkills.includes(candidateSkill)) {
        desiredSkills.push(candidateSkill);
      }
    }

    teams[t - 1] = {
      id: teamId,
      index: t,
      hackathonId,
      name: `LoadTest Crew ${paddedTeam}`,
      description: `Benchmark team #${paddedTeam} (${teamSize}/5 members) for 100-VU k6 scale verification.`,
      desiredSkills,
      leaderUserId: leader.id,
      status: 'ready',
      memberCount: teamSize,
      minTeamSize: 2,
      maxTeamSize: 5,
      lookingForMembers: !isFull,
      createdAt: teamCreatedAtIso,
    };
  }

  return { participants, teams, memberships };
}

/**
 * Enforces all non-negotiable Batch 06 Section 6 safety guards before touching the database.
 */
export async function assertScaleSeedSafetyGuards(
  pool: Pool,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ databaseName: string }> {
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'SCALE_SEED_REFUSED: Scale seeder is strictly forbidden when NODE_ENV=production.',
    );
  }

  if (env.CREWMESH_ALLOW_SCALE_SEED !== 'true') {
    throw new Error(
      'SCALE_SEED_REFUSED: Explicit flag CREWMESH_ALLOW_SCALE_SEED=true is required to run the scale seeder.',
    );
  }

  const dbRes = await pool.query<{ db_name: string }>('SELECT current_database() AS db_name');
  const dbName = dbRes.rows[0]?.db_name ?? '';

  if (!dbName.endsWith('_loadtest')) {
    throw new Error(
      `SCALE_SEED_REFUSED: Connected database "${dbName}" does not end with the required "_loadtest" suffix (e.g. crewmesh_loadtest). Refusing to seed benchmark fixtures into an application or test database.`,
    );
  }

  return { databaseName: dbName };
}

/**
 * Executes the 11 required SQL count and integrity queries from Section 14.5 of Batch 06.
 */
export async function queryScaleDatabaseCounts(
  db: Pool | PoolClient,
  hackathonId: string,
): Promise<ScaleDatabaseCountsSnapshot> {
  const [
    dbNameRes,
    participantsRes,
    eligibleRes,
    teamsRes,
    membershipsRes,
    sizeDistRes,
    unassignedRes,
    fullTeamsRes,
    openTeamsRes,
    badCounterRes,
    badLeaderRes,
    dupMembershipRes,
  ] = await Promise.all([
    db.query<{ db_name: string }>('SELECT current_database() AS db_name'),
    db.query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM users WHERE email LIKE '%@crewmesh.invalid'",
    ),
    db.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt
       FROM hackathon_participants hp
       INNER JOIN users u ON u.id = hp.user_id
       WHERE hp.hackathon_id = $1
         AND hp.status = 'registered'
         AND u.email LIKE '%@crewmesh.invalid'`,
      [hackathonId],
    ),
    db.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM teams WHERE hackathon_id = $1',
      [hackathonId],
    ),
    db.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM team_members WHERE hackathon_id = $1',
      [hackathonId],
    ),
    db.query<{ member_count: number; teams_count: number }>(
      `SELECT member_count, COUNT(*)::int AS teams_count
       FROM teams
       WHERE hackathon_id = $1
       GROUP BY member_count
       ORDER BY member_count ASC`,
      [hackathonId],
    ),
    db.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt
       FROM hackathon_participants hp
       INNER JOIN users u ON u.id = hp.user_id
       WHERE hp.hackathon_id = $1
         AND hp.status = 'registered'
         AND u.email LIKE '%@crewmesh.invalid'
         AND NOT EXISTS (
           SELECT 1 FROM team_members tm
           WHERE tm.hackathon_id = $1 AND tm.user_id = u.id
         )`,
      [hackathonId],
    ),
    db.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt
       FROM teams
       WHERE hackathon_id = $1 AND member_count = max_team_size AND looking_for_members = FALSE`,
      [hackathonId],
    ),
    db.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt
       FROM teams
       WHERE hackathon_id = $1 AND member_count < max_team_size AND looking_for_members = TRUE`,
      [hackathonId],
    ),
    db.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt
       FROM teams t
       WHERE t.hackathon_id = $1
         AND t.member_count <> (
           SELECT COUNT(*)::int FROM team_members tm WHERE tm.team_id = t.id
         )`,
      [hackathonId],
    ),
    db.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt
       FROM teams t
       WHERE t.hackathon_id = $1
         AND (
           (SELECT COUNT(*)::int FROM team_members tm WHERE tm.team_id = t.id AND tm.role = 'leader') <> 1
           OR t.leader_user_id <> (
             SELECT tm2.user_id FROM team_members tm2 WHERE tm2.team_id = t.id AND tm2.role = 'leader' LIMIT 1
           )
         )`,
      [hackathonId],
    ),
    db.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt
       FROM (
         SELECT user_id
         FROM team_members
         WHERE hackathon_id = $1
         GROUP BY user_id
         HAVING COUNT(*) > 1
       ) dup`,
      [hackathonId],
    ),
  ]);

  const distribution: Record<string, number> = {};
  for (const row of sizeDistRes.rows) {
    distribution[String(row.member_count)] = row.teams_count;
  }

  return {
    databaseName: dbNameRes.rows[0]?.db_name ?? '',
    hackathonId,
    capturedAt: new Date().toISOString(),
    participantsCount: participantsRes.rows[0]?.cnt ?? 0,
    hackathonEligibleParticipantsCount: eligibleRes.rows[0]?.cnt ?? 0,
    teamsCount: teamsRes.rows[0]?.cnt ?? 0,
    membershipsCount: membershipsRes.rows[0]?.cnt ?? 0,
    teamSizeDistribution: distribution,
    unassignedParticipantsCount: unassignedRes.rows[0]?.cnt ?? 0,
    fullTeamsCount: fullTeamsRes.rows[0]?.cnt ?? 0,
    openCapacityTeamsCount: openTeamsRes.rows[0]?.cnt ?? 0,
    incorrectMemberCounterTeamsCount: badCounterRes.rows[0]?.cnt ?? 0,
    incorrectLeaderCountTeamsCount: badLeaderRes.rows[0]?.cnt ?? 0,
    duplicateTeamMembershipUsersCount: dupMembershipRes.rows[0]?.cnt ?? 0,
  };
}

/**
 * Captures real PostgreSQL `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)` plans
 * for the primary board queries and candidate recommendation query.
 */
export async function captureBoardExplainPlans(
  db: Pool | PoolClient,
  hackathonId: string,
): Promise<Record<string, unknown>> {
  const sampleTeamId = makeDeterministicScaleUuid('team', 1);

  const [
    unfilteredPage1Plan,
    openCapacityPlan,
    lookingForMembersPlan,
    skillFilterPlan,
    memberHydrationPlan,
    suggestionsCandidatePlan,
  ] = await Promise.all([
    db.query(
      `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)
       SELECT
         t.id, t.hackathon_id, t.name, t.description, t.desired_skills,
         t.leader_user_id, t.status, t.member_count, t.min_team_size,
         t.max_team_size, t.looking_for_members, t.created_at, t.updated_at
       FROM teams t
       WHERE t.hackathon_id = $1
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT 21`,
      [hackathonId],
    ),
    db.query(
      `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)
       SELECT
         t.id, t.hackathon_id, t.name, t.description, t.desired_skills,
         t.leader_user_id, t.status, t.member_count, t.min_team_size,
         t.max_team_size, t.looking_for_members, t.created_at, t.updated_at
       FROM teams t
       WHERE t.hackathon_id = $1
         AND t.member_count < t.max_team_size
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT 21`,
      [hackathonId],
    ),
    db.query(
      `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)
       SELECT
         t.id, t.hackathon_id, t.name, t.description, t.desired_skills,
         t.leader_user_id, t.status, t.member_count, t.min_team_size,
         t.max_team_size, t.looking_for_members, t.created_at, t.updated_at
       FROM teams t
       WHERE t.hackathon_id = $1
         AND t.looking_for_members = TRUE
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT 21`,
      [hackathonId],
    ),
    db.query(
      `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)
       SELECT
         t.id, t.hackathon_id, t.name, t.description, t.desired_skills,
         t.leader_user_id, t.status, t.member_count, t.min_team_size,
         t.max_team_size, t.looking_for_members, t.created_at, t.updated_at
       FROM teams t
       WHERE t.hackathon_id = $1
         AND t.desired_skills @> ARRAY['rust']::text[]
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT 21`,
      [hackathonId],
    ),
    db.query(
      `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)
       SELECT
         tm.team_id, tm.user_id, u.display_name, u.skills,
         u.timezone, u.timezone_confirmed_at, u.bio, tm.role, tm.joined_at
       FROM team_members tm
       INNER JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = ANY($1::uuid[])
       ORDER BY
         tm.team_id ASC,
         CASE WHEN tm.role = 'leader' THEN 0 ELSE 1 END ASC,
         tm.joined_at ASC,
         tm.user_id ASC`,
      [Array.from({ length: 20 }, (_, idx) => makeDeterministicScaleUuid('team', idx + 1))],
    ),
    db.query(
      `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)
       SELECT
         u.id, u.display_name, u.skills, u.timezone, u.timezone_confirmed_at
       FROM hackathon_participants hp
       INNER JOIN users u ON u.id = hp.user_id
       WHERE hp.hackathon_id = $1
         AND hp.status = 'registered'
         AND NOT EXISTS (
           SELECT 1 FROM team_members tm
           WHERE tm.hackathon_id = $1 AND tm.user_id = u.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM join_requests jr
           WHERE jr.team_id = $2 AND jr.user_id = u.id AND jr.status = 'pending'
         )
       ORDER BY u.id ASC`,
      [hackathonId, sampleTeamId],
    ),
  ]);

  return {
    capturedAt: new Date().toISOString(),
    hackathonId,
    plans: {
      boardUnfilteredPage1: unfilteredPage1Plan.rows[0],
      boardOpenCapacityFilter: openCapacityPlan.rows[0],
      boardLookingForMembersFilter: lookingForMembersPlan.rows[0],
      boardSkillGinFilter: skillFilterPlan.rows[0],
      boardBatchMemberHydration20Teams: memberHydrationPlan.rows[0],
      suggestionsEligibleCandidatesQuery: suggestionsCandidatePlan.rows[0],
    },
  };
}

/**
 * Seeds the deterministic 10,000-participant, 2,000-team, 7,000-membership benchmark dataset
 * idempotently using bulk parameterized `UNNEST` queries inside a deferred-constraint transaction.
 */
export async function seedScaleDataset(
  pool: Pool = getDbPool(),
  options?: { writeReportsToDisk?: boolean },
): Promise<{
  beforeCounts: ScaleDatabaseCountsSnapshot;
  afterCounts: ScaleDatabaseCountsSnapshot;
  explainPlans: Record<string, unknown>;
}> {
  const { databaseName } = await assertScaleSeedSafetyGuards(pool);
  const hackathon = await seedHackathon(pool);

  console.info(
    JSON.stringify({
      action: 'db:seed:scale:start',
      databaseName,
      hackathonId: hackathon.id,
      hackathonSlug: hackathon.slug,
      plannedCounts: {
        participants: SCALE_TOTAL_PARTICIPANTS,
        teams: SCALE_TOTAL_TEAMS,
        memberships: SCALE_TOTAL_MEMBERSHIPS,
        unassignedParticipants: SCALE_UNASSIGNED_PARTICIPANTS,
      },
    }),
  );

  const beforeCounts = await queryScaleDatabaseCounts(pool, hackathon.id);

  // Generate a single inaccessible CSPRNG password hashed once with real Argon2id (never logged)
  const ephemeralSecret = `ScaleBench!${crypto.randomBytes(24).toString('base64url')}`;
  const benchmarkPasswordHash = await hashPassword(ephemeralSecret);

  const { participants, teams, memberships } = buildDeterministicScaleDataset(hackathon.id);

  await withTransaction(async (client) => {
    // Defer team/member integrity trigger checks until the end of the transaction
    // so bulk team and membership upserts are verified atomically at commit time.
    await client.query('SET CONSTRAINTS ALL DEFERRED');

    const userBatchSize = 1_000;
    for (let offset = 0; offset < participants.length; offset += userBatchSize) {
      const slice = participants.slice(offset, offset + userBatchSize);
      const ids = slice.map((p) => p.id);
      const emails = slice.map((p) => p.email);
      const names = slice.map((p) => p.displayName);
      const skillsJson = JSON.stringify(slice.map((p) => p.skills));
      const timezones = slice.map((p) => p.timezone);
      const confirmedAts = slice.map((p) => p.timezoneConfirmedAt);
      const bios = slice.map((p) => p.bio);
      const createdAts = slice.map((p) => p.createdAt);

      await client.query(
        `
        WITH input_rows AS (
          SELECT
            u.ord,
            u.id,
            u.email,
            u.display_name,
            u.timezone,
            u.timezone_confirmed_at,
            u.bio,
            u.created_at,
            ARRAY(
              SELECT jsonb_array_elements_text($5::jsonb -> (u.ord::int - 1))
            ) AS skills
          FROM UNNEST(
            $1::uuid[],
            $2::text[],
            $3::text[],
            $4::text[],
            $6::timestamptz[],
            $7::text[],
            $8::timestamptz[]
          ) WITH ORDINALITY AS u(
            id,
            email,
            display_name,
            timezone,
            timezone_confirmed_at,
            bio,
            created_at,
            ord
          )
        )
        INSERT INTO users (
          id,
          email,
          password_hash,
          display_name,
          skills,
          timezone,
          timezone_confirmed_at,
          bio,
          created_at,
          updated_at
        )
        SELECT
          id,
          email,
          $9::text,
          display_name,
          skills,
          timezone,
          timezone_confirmed_at,
          bio,
          created_at,
          created_at
        FROM input_rows
        ON CONFLICT (id) DO UPDATE SET
          email = EXCLUDED.email,
          display_name = EXCLUDED.display_name,
          skills = EXCLUDED.skills,
          timezone = EXCLUDED.timezone,
          timezone_confirmed_at = EXCLUDED.timezone_confirmed_at,
          bio = EXCLUDED.bio,
          updated_at = EXCLUDED.updated_at
        WHERE users.email LIKE '%@crewmesh.invalid'
        `,
        [
          ids,
          emails,
          names,
          timezones,
          skillsJson,
          confirmedAts,
          bios,
          createdAts,
          benchmarkPasswordHash,
        ],
      );

      const participantRowIds = slice.map((p) =>
        makeDeterministicScaleUuid('participant', p.index),
      );
      await client.query(
        `
        INSERT INTO hackathon_participants (
          id,
          hackathon_id,
          user_id,
          status,
          registered_at
        )
        SELECT
          p.id,
          $2::uuid,
          p.user_id,
          'registered',
          p.registered_at
        FROM UNNEST(
          $1::uuid[],
          $3::uuid[],
          $4::timestamptz[]
        ) AS p(id, user_id, registered_at)
        ON CONFLICT (hackathon_id, user_id) DO UPDATE SET
          status = 'registered'
        `,
        [participantRowIds, hackathon.id, ids, createdAts],
      );
    }

    const teamBatchSize = 1_000;
    for (let offset = 0; offset < teams.length; offset += teamBatchSize) {
      const slice = teams.slice(offset, offset + teamBatchSize);
      const ids = slice.map((t) => t.id);
      const names = slice.map((t) => t.name);
      const descriptions = slice.map((t) => t.description);
      const desiredSkillsJson = JSON.stringify(slice.map((t) => t.desiredSkills));
      const leaderIds = slice.map((t) => t.leaderUserId);
      const statuses = slice.map((t) => t.status);
      const memberCounts = slice.map((t) => t.memberCount);
      const minSizes = slice.map((t) => t.minTeamSize);
      const maxSizes = slice.map((t) => t.maxTeamSize);
      const lookingFlags = slice.map((t) => t.lookingForMembers);
      const createdAts = slice.map((t) => t.createdAt);

      await client.query(
        `
        WITH input_teams AS (
          SELECT
            t.ord,
            t.id,
            t.name,
            t.description,
            t.leader_user_id,
            t.status,
            t.member_count,
            t.min_team_size,
            t.max_team_size,
            t.looking_for_members,
            t.created_at,
            ARRAY(
              SELECT jsonb_array_elements_text($4::jsonb -> (t.ord::int - 1))
            ) AS desired_skills
          FROM UNNEST(
            $1::uuid[],
            $2::text[],
            $3::text[],
            $5::uuid[],
            $6::text[],
            $7::int[],
            $8::int[],
            $9::int[],
            $10::boolean[],
            $11::timestamptz[]
          ) WITH ORDINALITY AS t(
            id,
            name,
            description,
            leader_user_id,
            status,
            member_count,
            min_team_size,
            max_team_size,
            looking_for_members,
            created_at,
            ord
          )
        )
        INSERT INTO teams (
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
        )
        SELECT
          id,
          $12::uuid,
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
          created_at
        FROM input_teams
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          desired_skills = EXCLUDED.desired_skills,
          leader_user_id = EXCLUDED.leader_user_id,
          status = EXCLUDED.status,
          member_count = EXCLUDED.member_count,
          min_team_size = EXCLUDED.min_team_size,
          max_team_size = EXCLUDED.max_team_size,
          looking_for_members = EXCLUDED.looking_for_members,
          updated_at = EXCLUDED.updated_at
        `,
        [
          ids,
          names,
          descriptions,
          desiredSkillsJson,
          leaderIds,
          statuses,
          memberCounts,
          minSizes,
          maxSizes,
          lookingFlags,
          createdAts,
          hackathon.id,
        ],
      );
    }

    const memberBatchSize = 1_000;
    for (let offset = 0; offset < memberships.length; offset += memberBatchSize) {
      const slice = memberships.slice(offset, offset + memberBatchSize);
      const ids = slice.map((m) => m.id);
      const teamIds = slice.map((m) => m.teamId);
      const userIds = slice.map((m) => m.userId);
      const roles = slice.map((m) => m.role);
      const joinedAts = slice.map((m) => m.joinedAt);

      await client.query(
        `
        INSERT INTO team_members (
          id,
          team_id,
          hackathon_id,
          user_id,
          role,
          joined_at
        )
        SELECT
          m.id,
          m.team_id,
          $6::uuid,
          m.user_id,
          m.role,
          m.joined_at
        FROM UNNEST(
          $1::uuid[],
          $2::uuid[],
          $3::uuid[],
          $4::text[],
          $5::timestamptz[]
        ) AS m(id, team_id, user_id, role, joined_at)
        ON CONFLICT (hackathon_id, user_id) DO UPDATE SET
          team_id = EXCLUDED.team_id,
          role = EXCLUDED.role,
          joined_at = EXCLUDED.joined_at
        `,
        [ids, teamIds, userIds, roles, joinedAts, hackathon.id],
      );
    }
  }, pool);

  // Update planner statistics so PostgreSQL query plans reflect the freshly seeded 10k/2k tables
  await pool.query('ANALYZE users, hackathon_participants, teams, team_members, join_requests');

  const afterCounts = await queryScaleDatabaseCounts(pool, hackathon.id);
  const explainPlans = await captureBoardExplainPlans(pool, hackathon.id);

  // Verify post-seed invariants
  if (
    afterCounts.participantsCount !== SCALE_TOTAL_PARTICIPANTS ||
    afterCounts.hackathonEligibleParticipantsCount !== SCALE_TOTAL_PARTICIPANTS ||
    afterCounts.teamsCount !== SCALE_TOTAL_TEAMS ||
    afterCounts.membershipsCount !== SCALE_TOTAL_MEMBERSHIPS ||
    afterCounts.unassignedParticipantsCount !== SCALE_UNASSIGNED_PARTICIPANTS ||
    afterCounts.fullTeamsCount !== 500 ||
    afterCounts.openCapacityTeamsCount !== 1500 ||
    afterCounts.incorrectMemberCounterTeamsCount !== 0 ||
    afterCounts.incorrectLeaderCountTeamsCount !== 0 ||
    afterCounts.duplicateTeamMembershipUsersCount !== 0
  ) {
    throw new Error(
      `SCALE_SEED_VERIFICATION_FAILED: Post-seed SQL counts did not match required invariants: ${JSON.stringify(afterCounts)}`,
    );
  }

  if (options?.writeReportsToDisk !== false) {
    const reportsDir = path.resolve(__dirname, '../../../../reports/load-test');
    fs.mkdirSync(reportsDir, { recursive: true });
    fs.writeFileSync(
      path.join(reportsDir, 'database-counts.json'),
      JSON.stringify({ beforeCounts, afterCounts }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(reportsDir, 'board-explain-plan.json'),
      JSON.stringify(explainPlans, null, 2),
      'utf8',
    );
  }

  console.info(
    JSON.stringify({
      action: 'db:seed:scale:complete',
      databaseName,
      beforeCounts,
      afterCounts,
    }),
  );

  return { beforeCounts, afterCounts, explainPlans };
}

async function runCli(): Promise<void> {
  try {
    await seedScaleDataset();
  } finally {
    await closeDbPool();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runCli().catch((err) => {
    console.error(
      JSON.stringify({
        error: 'SCALE_SEED_FAILED',
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    process.exitCode = 1;
  });
}
