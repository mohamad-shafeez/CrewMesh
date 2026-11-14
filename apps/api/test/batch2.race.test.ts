import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  InviteCodeCreatedDto,
  InviteRedeemResultDto,
  JoinRequestDto,
  TeamDetailsDto,
} from '@crewmesh/shared';
import { buildApp } from '../src/app.js';
import { getEnv, resetEnvCache } from '../src/config/env.js';
import { runMigrationsUp } from '../src/db/migrate.js';
import { closeDbPool, getDbPool } from '../src/db/pool.js';
import { seedHackathon } from '../src/db/seed.js';
import { deriveCsrfToken, generateOpaqueToken, hashPassword, sha256Hex } from '../src/security/crypto.js';

const TEST_OR/**
 * Test-only fixture: creates an authenticated participant directly in PostgreSQL.
 * This avoids the public registration IP rate limit during high-volume race setup.
 */
let cachedRacePasswordHash: string | null = null;

async function createAuthenticatedUser(
  hackathonId: string,
  index: number,
): Promise<RaceActor> {
  const pool = getDbPool();
  const env = getEnv();
  const email = `racer_${index}_${crypto.randomUUID().slice(0, 8)}@example.com`;

  if (!cachedRacePasswordHash) {
    cachedRacePasswordHash = await hashPassword('RaceTestPassword!2026');
  }

  const rawToken = generateOpaqueToken(32);
  const tokenHash = sha256Hex(rawToken);
  const csrfToken = deriveCsrfToken(tokenHash, env.CSRF_SECRET);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const userResult = await client.query<{ id: string }>(
      `
      INSERT INTO users (
        email, password_hash, display_name, skills,
        timezone, timezone_confirmed_at, bio
      )
      VALUES ($1, $2, $3, $4, 'UTC', NOW(), '')
      RETURNING id
      `,
      [
        email,
        cachedRacePasswordHash,
        `Racer ${index}`,
        ['typescript', 'postgresql'],
      ],
    );

    const userId = userResult.rows[0]!.id;

    await client.query(
      `
      INSERT INTO hackathon_participants (hackathon_id, user_id, status)
      VALUES ($1, $2, 'registered')
      `,
      [hackathonId, userId],
    );

    await client.query(
      `
      INSERT INTO sessions (
        user_id, token_hash, csrf_token_hash,
        ip_address, user_agent, expires_at
      )
      VALUES ($1, $2, $3, '127.0.0.1', 'crewmesh-race-fixture',
              NOW() + ($4::int * INTERVAL '1 second'))
      `,
      [
        userId,
        tokenHash,
        sha256Hex(csrfToken),
        env.SESSION_TTL_HOURS * 3600,
      ],
    );

    await client.query('COMMIT');

    return {
      userId,
      cookie: `${env.SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}`,
      csrfToken,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

body.user.id,
    cookie: `crewmesh_session=${encodeURIComponent(token!)}`,
    csrfToken: body.csrfToken,
  };
}

describe('Batch 2 & 3 — 50-Way Last-Seat Concurrency & Invite Use-Limit Race Proof (Real PostgreSQL)', () => {
  let app: FastifyInstance;
  let hackathonId: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.APP_ORIGIN = TEST_ORIGIN;
    process.env.CSRF_SECRET = 'race_test_csrf_secret_with_at_least_32_bytes_entropy_012345';
    process.env.HACKATHON_DEADLINE_ISO = '';
    process.env.DATABASE_URL =
      process.env.TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://crewmesh:crewmesh_local_dev_password@localhost:5432/crewmesh_test';
    resetEnvCache();

    await runMigrationsUp();
    const seeded = await seedHackathon();
    hackathonId = seeded.id;
    app = await buildApp();
    await app.ready();
  });

  beforeEach(async () => {
    const pool = getDbPool();
    await pool.query(`
      TRUNCATE TABLE
        rate_limit_buckets,
        outbox_events,
        audit_log,
        idempotency_keys,
        sessions,
        join_requests,
        invite_codes,
        team_members,
        teams,
        users
      RESTART IDENTITY CASCADE
    `);
    const seeded = await seedHackathon(pool);
    hackathonId = seeded.id;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    await closeDbPool();
  });

  it('1. 50 simultaneous join-request acceptances for 1 remaining seat result in EXACTLY 1 success and 49 TEAM_FULL conflicts', async () => {
    const pool = getDbPool();

    await pool.query(
      'UPDATE hackathons SET min_team_size = 2, max_team_size = 2 WHERE id = $1',
      [hackathonId],
    );

    const leader = await createAuthenticatedUser(hackathonId, 0);

    const createTeamRes = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: {
        origin: TEST_ORIGIN,
        cookie: leader.cookie,
        'x-csrf-token': leader.csrfToken,
        'idempotency-key': `idem_race_team_${crypto.randomUUID()}`,
      },
      payload: {
        name: 'Last Seat Showdown Team',
        minTeamSize: 2,
        maxTeamSize: 2,
      },
    });
    expect(createTeamRes.statusCode).toBe(201);
    const teamId = createTeamRes.json<{ team: TeamDetailsDto }>().team.id;

    const applicantCount = 50;
    const requestIds: string[] = [];

    for (let i = 1; i <= applicantCount; i += 1) {
      const applicant = await createAuthenticatedUser(hackathonId, i);
      const jrRes = await app.inject({
        method: 'POST',
        url: `/api/v1/teams/${teamId}/join-requests`,
        headers: {
          origin: TEST_ORIGIN,
          cookie: applicant.cookie,
          'x-csrf-token': applicant.csrfToken,
          'idempotency-key': `idem_jr_${i}_${crypto.randomUUID()}`,
        },
        payload: {
          message: `Concurrent applicant #${i}`,
        },
      });
      expect(jrRes.statusCode).toBe(201);
      requestIds.push(jrRes.json<{ joinRequest: JoinRequestDto }>().joinRequest.id);
    }

    const acceptPromises = requestIds.map((requestId, idx) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/teams/${teamId}/join-requests/${requestId}/accept`,
        headers: {
          origin: TEST_ORIGIN,
          cookie: leader.cookie,
          'x-csrf-token': leader.csrfToken,
          'idempotency-key': `idem_accept_${idx}_${crypto.randomUUID()}`,
        },
      }),
    );

    const responses = await Promise.all(acceptPromises);

    const succeeded = responses.filter((r) => r.statusCode === 200);
    const conflicts = responses.filter((r) => r.statusCode === 409);
    const serverErrors = responses.filter((r) => r.statusCode >= 500);

    expect(serverErrors).toHaveLength(0);
    expect(succeeded).toHaveLength(1);
    expect(conflicts).toHaveLength(49);

    for (const conflictRes of conflicts) {
      const errBody = conflictRes.json<{ error: { code: string } }>();
      expect(errBody.error.code).toBe('TEAM_FULL');
    }

    const memberRowsRes = await pool.query<{ user_id: string; role: string }>(
      'SELECT user_id, role FROM team_members WHERE team_id = $1 ORDER BY joined_at ASC',
      [teamId],
    );
    expect(memberRowsRes.rows).toHaveLength(2);
    expect(memberRowsRes.rows.filter((r) => r.role === 'leader')).toHaveLength(1);
    expect(memberRowsRes.rows.filter((r) => r.role === 'member')).toHaveLength(1);

    const teamRowRes = await pool.query<{
      member_count: number;
      max_team_size: number;
      status: string;
    }>('SELECT member_count, max_team_size, status FROM teams WHERE id = $1', [teamId]);
    expect(teamRowRes.rows[0]?.member_count).toBe(2);
    expect(teamRowRes.rows[0]?.max_team_size).toBe(2);
    expect(teamRowRes.rows[0]?.status).toBe('ready');

    const acceptedJrRes = await pool.query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM join_requests WHERE team_id = $1 AND status = 'accepted'",
      [teamId],
    );
    const pendingJrRes = await pool.query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM join_requests WHERE team_id = $1 AND status = 'pending'",
      [teamId],
    );
    expect(acceptedJrRes.rows[0]?.cnt).toBe(1);
    expect(pendingJrRes.rows[0]?.cnt).toBe(49);

    const auditAcceptRes = await pool.query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM audit_log WHERE team_id = $1 AND action = 'JOIN_REQUEST_ACCEPTED'",
      [teamId],
    );
    expect(auditAcceptRes.rows[0]?.cnt).toBe(1);
  });

  it('2. 20 simultaneous invite code redemptions against maxUses = 3 create EXACTLY 3 pending join requests, 0 direct memberships, and enforce capacity when leader accepts', async () => {
    const pool = getDbPool();
    await pool.query(
      'UPDATE hackathons SET min_team_size = 2, max_team_size = 2 WHERE id = $1',
      [hackathonId],
    );

    const leader = await createAuthenticatedUser(hackathonId, 100);
    const teamId = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/hackathons/${hackathonId}/teams`,
        headers: {
          origin: TEST_ORIGIN,
          cookie: leader.cookie,
          'x-csrf-token': leader.csrfToken,
          'idempotency-key': `idem_inv_race_${crypto.randomUUID()}`,
        },
        payload: {
          name: 'Invite Use Limit Race Team',
          minTeamSize: 2,
          maxTeamSize: 2,
        },
      })
    ).json<{ team: TeamDetailsDto }>().team.id;

    const invite = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/teams/${teamId}/invites`,
        headers: {
          origin: TEST_ORIGIN,
          cookie: leader.cookie,
          'x-csrf-token': leader.csrfToken,
          'idempotency-key': `idem_inv_create_${crypto.randomUUID()}`,
        },
        payload: {
          maxUses: 3,
          expiresInHours: 12,
        },
      })
    ).json<{ invite: InviteCodeCreatedDto }>().invite;

    const contenders: RaceActor[] = [];
    for (let i = 1; i <= 20; i += 1) {
      contenders.push(await createAuthenticatedUser(hackathonId, 200 + i));
    }

    const redeemResponses = await Promise.all(
      contenders.map((contender, idx) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/invites/redeem',
          headers: {
            origin: TEST_ORIGIN,
            cookie: contender.cookie,
            'x-csrf-token': contender.csrfToken,
            'idempotency-key': `idem_redeem_${idx}_${crypto.randomUUID()}`,
          },
          payload: { code: invite.code },
        }),
      ),
    );

    const createdRequests = redeemResponses.filter((r) => r.statusCode === 201);
    const exhaustedConflicts = redeemResponses.filter((r) => r.statusCode === 409);
    expect(createdRequests).toHaveLength(3);
    expect(exhaustedConflicts).toHaveLength(17);

    const inviteRow = await pool.query<{ use_count: number }>(
      'SELECT use_count FROM invite_codes WHERE id = $1',
      [invite.id],
    );
    expect(inviteRow.rows[0]?.use_count).toBe(3);

    // Verify redemption did NOT bypass leader approval (still only 1 member in team_members)
    const memberCountBeforeAccept = await pool.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM team_members WHERE team_id = $1',
      [teamId],
    );
    expect(memberCountBeforeAccept.rows[0]?.cnt).toBe(1);

    // Leader now concurrently accepts all 3 invite-sourced join requests for the 1 remaining seat
    const createdJrIds = createdRequests.map(
      (r) => r.json<InviteRedeemResultDto>().joinRequest.id,
    );
    const leaderAccepts = await Promise.all(
      createdJrIds.map((jrId, idx) =>
        app.inject({
          method: 'POST',
          url: `/api/v1/teams/${teamId}/join-requests/${jrId}/accept`,
          headers: {
            origin: TEST_ORIGIN,
            cookie: leader.cookie,
            'x-csrf-token': leader.csrfToken,
            'idempotency-key': `idem_inv_acc_${idx}_${crypto.randomUUID()}`,
          },
        }),
      ),
    );

    expect(leaderAccepts.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(leaderAccepts.filter((r) => r.statusCode === 409)).toHaveLength(2);

    const memberCountAfterAccept = await pool.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM team_members WHERE team_id = $1',
      [teamId],
    );
    expect(memberCountAfterAccept.rows[0]?.cnt).toBe(2);
  });
});
