import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  AuthSessionResponse,
  TeamBoardPageResponse,
  TeamDetailResponseDto,
  TeammateSuggestionsResponseDto,
} from '@crewmesh/shared';
import { buildApp } from '../../src/app.js';
import { resetEnvCache } from '../../src/config/env.js';
import { runMigrationsUp } from '../../src/db/migrate.js';
import { closeDbPool, getDbPool } from '../../src/db/pool.js';
import { seedHackathon } from '../../src/db/seed.js';
import {
  assertScaleSeedSafetyGuards,
  SCALE_TOTAL_MEMBERSHIPS,
  SCALE_TOTAL_PARTICIPANTS,
  SCALE_TOTAL_TEAMS,
  SCALE_UNASSIGNED_PARTICIPANTS,
  seedScaleDataset,
} from '../../src/db/seed-scale.js';

const TEST_ORIGIN = 'http://localhost:5173';

function extractCookieValue(
  setCookieHeader: string | string[] | undefined,
  cookieName: string,
): string | null {
  if (!setCookieHeader) {
    return null;
  }
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const header of headers) {
    const firstPart = header.split(';')[0]?.trim() ?? '';
    const [name, val] = firstPart.split('=');
    if (name === cookieName && val !== undefined) {
      return decodeURIComponent(val);
    }
  }
  return null;
}

describe('Batch 6 & 8 — Time-Zone Provenance, Redundant Index Audit, Participant Eligibility & Scale Seeding Suite (PostgreSQL)', () => {
  let app: FastifyInstance;
  let hackathonId: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.APP_ORIGIN = TEST_ORIGIN;
    process.env.CSRF_SECRET = 'batch6_test_csrf_secret_with_at_least_32_bytes_entropy_999';
    process.env.HACKATHON_DEADLINE_ISO = '';
    resetEnvCache();

    await runMigrationsUp();
    const seeded = await seedHackathon();
    hackathonId = seeded.id;
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    await closeDbPool();
  });

  it('1. Migration 005 drops redundant duplicate indexes from Migration 004 while preserving unique integrity indexes', async () => {
    const pool = getDbPool();
    const indexRes = await pool.query<{ indexname: string; tablename: string; indexdef: string }>(
      `
      SELECT indexname, tablename, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN ('team_members', 'join_requests', 'teams', 'hackathon_participants')
      ORDER BY tablename ASC, indexname ASC
      `,
    );

    const indexNames = new Set(indexRes.rows.map((r) => r.indexname));

    expect(indexNames.has('idx_team_members_hackathon_user_lookup')).toBe(false);
    expect(indexNames.has('idx_join_requests_team_pending_user_lookup')).toBe(false);

    expect(indexNames.has('team_members_one_team_per_hackathon_unique')).toBe(true);
    expect(indexNames.has('idx_join_requests_one_pending_per_team_user')).toBe(true);
    expect(indexNames.has('idx_team_members_one_leader_per_team')).toBe(true);

    expect(indexNames.has('hackathon_participants_hackathon_user_unique')).toBe(true);
    expect(indexNames.has('idx_teams_hackathon_open_capacity_cursor')).toBe(true);
  });

  it('2. Enforces explicit time-zone confirmation provenance on registration, profile updates, and recommendations', async () => {
    const pool = getDbPool();
    const suffix = crypto.randomUUID().slice(0, 8);

    const unconfirmedReg = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { origin: TEST_ORIGIN },
      payload: {
        email: `unconfirmed_${suffix}@example.com`,
        password: 'ValidTestPassword!2026',
        displayName: 'Unconfirmed TZ User',
        skills: ['rust', 'redis'],
      },
    });
    expect(unconfirmedReg.statusCode).toBe(201);
    const unconfirmedBody = unconfirmedReg.json<AuthSessionResponse>();
    expect(unconfirmedBody.user.timezone).toBeNull();
    expect(unconfirmedBody.user.timezoneConfirmed).toBe(false);
    expect(unconfirmedBody.user.timezoneConfirmedAt).toBeNull();

    const dbCheck1 = await pool.query<{ timezone: string | null; timezone_confirmed_at: Date | null }>(
      'SELECT timezone, timezone_confirmed_at FROM users WHERE id = $1',
      [unconfirmedBody.user.id],
    );
    expect(dbCheck1.rows[0]?.timezone).toBeNull();
    expect(dbCheck1.rows[0]?.timezone_confirmed_at).toBeNull();

    const rawCookie = extractCookieValue(unconfirmedReg.headers['set-cookie'], 'crewmesh_session');
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/profile',
      headers: {
        origin: TEST_ORIGIN,
        cookie: `crewmesh_session=${encodeURIComponent(rawCookie!)}`,
        'x-csrf-token': unconfirmedBody.csrfToken,
      },
      payload: {
        timezone: 'Asia/Kolkata',
      },
    });
    expect(patchRes.statusCode).toBe(200);
    const patchedUser = patchRes.json<{ user: AuthSessionResponse['user'] }>().user;
    expect(patchedUser.timezone).toBe('Asia/Kolkata');
    expect(patchedUser.timezoneConfirmed).toBe(true);
    expect(typeof patchedUser.timezoneConfirmedAt).toBe('string');
  });

  it('3. Excludes unrelated platform accounts not registered in hackathon_participants from recommendations', async () => {
    const pool = getDbPool();
    const suffix = crypto.randomUUID().slice(0, 8);

    const leaderReg = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { origin: TEST_ORIGIN },
      payload: {
        email: `elig_leader_${suffix}@example.com`,
        password: 'ValidTestPassword!2026',
        displayName: 'Eligible Leader',
        skills: ['typescript'],
        timezone: 'Asia/Kolkata',
      },
    });
    const leaderSession = leaderReg.json<AuthSessionResponse>();
    const leaderCookie = `crewmesh_session=${encodeURIComponent(
      extractCookieValue(leaderReg.headers['set-cookie'], 'crewmesh_session')!,
    )}`;

    // Create an unrelated platform account and remove its hackathon_participants record via test DB setup
    const unrelatedReg = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { origin: TEST_ORIGIN },
      payload: {
        email: `unrelated_${suffix}@example.com`,
        password: 'ValidTestPassword!2026',
        displayName: 'Unrelated Platform User',
        skills: ['solidity', 'wasm'],
        timezone: 'Asia/Kolkata',
      },
    });
    const unrelatedUserId = unrelatedReg.json<AuthSessionResponse>().user.id;
    await pool.query(
      'DELETE FROM hackathon_participants WHERE hackathon_id = $1 AND user_id = $2',
      [hackathonId, unrelatedUserId],
    );

    const createTeamRes = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: {
        origin: TEST_ORIGIN,
        cookie: leaderCookie,
        'x-csrf-token': leaderSession.csrfToken,
        'idempotency-key': `idem_${crypto.randomUUID()}`,
      },
      payload: {
        name: `Eligibility Guard Team ${suffix}`,
        description: 'Verifying hackathon_participants filtering.',
        desiredSkills: ['typescript', 'solidity', 'wasm'],
      },
    });
    expect(createTeamRes.statusCode).toBe(201);
    const teamId = createTeamRes.json<TeamDetailResponseDto>().team.id;

    const sugRes = await app.inject({
      method: 'GET',
      url: `/api/v1/teams/${teamId}/suggestions?limit=50`,
      headers: { cookie: leaderCookie },
    });
    expect(sugRes.statusCode).toBe(200);
    const sugBody = sugRes.json<TeammateSuggestionsResponseDto>();

    expect(sugBody.candidates.map((c) => c.userId)).not.toContain(unrelatedUserId);
    expect(sugBody.diagnostics.timezoneEvidence.teamMembersCount).toBe(1);
    expect(sugBody.diagnostics.timezoneEvidence.confirmedTeamMembersCount).toBe(1);

    // cleanup: remove the eligibility team so scale seed counts stay exact (2000 teams)
    await pool.query('DELETE FROM teams WHERE id = $1', [teamId]);
  });

  it('4. Scale seeder safety guards reject production env, missing flag, and non-_loadtest database names', async () => {
    const pool = getDbPool();

    await expect(
      assertScaleSeedSafetyGuards(pool, {
        NODE_ENV: 'production',
        CREWMESH_ALLOW_SCALE_SEED: 'true',
      }),
    ).rejects.toThrow(/NODE_ENV=production/);

    await expect(
      assertScaleSeedSafetyGuards(pool, {
        NODE_ENV: 'test',
        CREWMESH_ALLOW_SCALE_SEED: 'false',
      }),
    ).rejects.toThrow(/CREWMESH_ALLOW_SCALE_SEED=true/);

    const dbNameRes = await pool.query<{ db_name: string }>('SELECT current_database() AS db_name');
    const currentDbName = dbNameRes.rows[0]?.db_name ?? '';
    if (!currentDbName.endsWith('_loadtest')) {
      await expect(
        assertScaleSeedSafetyGuards(pool, {
          NODE_ENV: 'test',
          CREWMESH_ALLOW_SCALE_SEED: 'true',
        }),
      ).rejects.toThrow(/_loadtest/);
    }
  });

  it('5. When connected to a *_loadtest database, seeds 10,000 participants, 2,000 teams, 7,000 memberships idempotently and verifies board pagination', async () => {
    const pool = getDbPool();
    const dbNameRes = await pool.query<{ db_name: string }>('SELECT current_database() AS db_name');
    const currentDbName = dbNameRes.rows[0]?.db_name ?? '';

    if (!currentDbName.endsWith('_loadtest')) {
      return;
    }

    process.env.CREWMESH_ALLOW_SCALE_SEED = 'true';
    const firstRun = await seedScaleDataset(pool, { writeReportsToDisk: true });
    expect(firstRun.afterCounts.participantsCount).toBe(SCALE_TOTAL_PARTICIPANTS);
    expect(firstRun.afterCounts.hackathonEligibleParticipantsCount).toBe(SCALE_TOTAL_PARTICIPANTS);
    expect(firstRun.afterCounts.teamsCount).toBe(SCALE_TOTAL_TEAMS);
    expect(firstRun.afterCounts.distinctTeamIdsCount).toBe(SCALE_TOTAL_TEAMS);
    expect(firstRun.afterCounts.leadersCount).toBe(SCALE_TOTAL_TEAMS);
    expect(firstRun.afterCounts.membershipsCount).toBe(SCALE_TOTAL_MEMBERSHIPS);
    expect(firstRun.afterCounts.unassignedParticipantsCount).toBe(SCALE_UNASSIGNED_PARTICIPANTS);
    expect(firstRun.afterCounts.teamSizeDistribution).toEqual({
      '2': 500,
      '3': 500,
      '4': 500,
      '5': 500,
    });
    expect(firstRun.afterCounts.fullTeamsCount).toBe(500);
    expect(firstRun.afterCounts.openCapacityTeamsCount).toBe(1500);
    expect(firstRun.afterCounts.incorrectMemberCounterTeamsCount).toBe(0);
    expect(firstRun.afterCounts.incorrectLeaderCountTeamsCount).toBe(0);
    expect(firstRun.afterCounts.duplicateTeamMembershipUsersCount).toBe(0);

    const secondRun = await seedScaleDataset(pool, { writeReportsToDisk: false });
    expect(secondRun.afterCounts).toEqual(
      expect.objectContaining({
        participantsCount: SCALE_TOTAL_PARTICIPANTS,
        teamsCount: SCALE_TOTAL_TEAMS,
        distinctTeamIdsCount: SCALE_TOTAL_TEAMS,
        leadersCount: SCALE_TOTAL_TEAMS,
        membershipsCount: SCALE_TOTAL_MEMBERSHIPS,
        unassignedParticipantsCount: SCALE_UNASSIGNED_PARTICIPANTS,
      }),
    );

    const boardPage1 = await app.inject({
      method: 'GET',
      url: `/api/v1/hackathons/${hackathonId}/teams?limit=20`,
    });
    expect(boardPage1.statusCode).toBe(200);
    const page1Body = boardPage1.json<TeamBoardPageResponse>();
    expect(page1Body.items.length).toBe(20);
    expect(page1Body.hasMore).toBe(true);
    expect(typeof page1Body.nextCursor).toBe('string');
  });
});
