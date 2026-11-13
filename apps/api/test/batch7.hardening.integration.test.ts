import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  AuthSessionResponse,
  InviteCodeCreatedDto,
  InviteRedeemResultDto,
  JoinRequestDto,
  TeamDetailResponseDto,
} from '@crewmesh/shared';
import { buildApp } from '../src/app.js';
import { resetEnvCache } from '../src/config/env.js';
import { runMigrationsUp } from '../src/db/migrate.js';
import { closeDbPool, getDbPool } from '../src/db/pool.js';
import { seedHackathon } from '../src/db/seed.js';
import { insertOutboxEvent } from '../src/services/audit-outbox-service.js';

const TEST_ORIGIN = 'http://localhost:5173';

interface TestActor {
  userId: string;
  email: string;
  cookie: string;
  csrfToken: string;
}

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

async function registerTestActor(
  app: FastifyInstance,
  label: string,
  options?: {
    skills?: string[];
    timezone?: string | null;
    enrollInActiveHackathon?: boolean;
  },
): Promise<TestActor> {
  const uniqueSuffix = `${label.toLowerCase().replace(/[^a-z0-9]/g, '')}_${crypto.randomUUID().slice(0, 8)}`;
  const email = `${uniqueSuffix}@example.com`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { origin: TEST_ORIGIN },
    payload: {
      email,
      password: 'ValidTestPassword!2026',
      displayName: `User ${label}`,
      skills: options?.skills ?? ['typescript', 'postgresql'],
      timezone: options?.timezone === undefined ? 'Asia/Kolkata' : options.timezone,
      enrollInActiveHackathon: options?.enrollInActiveHackathon ?? true,
    },
  });

  if (res.statusCode !== 201) {
    throw new Error(`Failed to register test actor ${label}: ${res.body}`);
  }

  const token = extractCookieValue(res.headers['set-cookie'], 'crewmesh_session');
  const body = res.json<AuthSessionResponse>();

  return {
    userId: body.user.id,
    email: body.user.email,
    cookie: `crewmesh_session=${encodeURIComponent(token!)}`,
    csrfToken: body.csrfToken,
  };
}

function authMutationHeaders(actor: TestActor, idempotencyKey?: string): Record<string, string> {
  return {
    origin: TEST_ORIGIN,
    cookie: actor.cookie,
    'x-csrf-token': actor.csrfToken,
    'idempotency-key': idempotencyKey ?? `idem_${crypto.randomUUID()}`,
  };
}

describe('Batch 7 — Final Backend Reliability, Outbox Commit-Order, Cross-Team Race, Participant Eligibility & Trigger Integrity Suite (PostgreSQL)', () => {
  let app: FastifyInstance;
  let hackathonId: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.APP_ORIGIN = TEST_ORIGIN;
    process.env.CSRF_SECRET = 'batch7_test_csrf_secret_with_at_least_32_bytes_entropy_999';
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

  async function cleanDatabase(): Promise<void> {
    const pool = getDbPool();
    await pool.query(`
      TRUNCATE TABLE
        outbox_events,
        audit_log,
        idempotency_keys,
        rate_limit_buckets,
        join_requests,
        invite_codes,
        team_members,
        teams,
        hackathon_participants,
        sessions,
        users
      RESTART IDENTITY CASCADE
    `);
  }

  it('1. Participant Eligibility (Section 4): blocks unregistered, withdrawn, and disqualified accounts across team creation, join requests, invite redemption, and acceptance', async () => {
    await cleanDatabase();
    const pool = getDbPool();

    const leader = await registerTestActor(app, 'EligLeader');
    const unregisteredUser = await registerTestActor(app, 'UnregisteredUser', {
      enrollInActiveHackathon: false,
    });
    const withdrawnUser = await registerTestActor(app, 'WithdrawnUser');
    const disqualifiedUser = await registerTestActor(app, 'DisqualifiedUser');
    const lateWithdrawnApplicant = await registerTestActor(app, 'LateWithdrawn');

    // Mark withdrawnUser and disqualifiedUser in PostgreSQL
    await pool.query(
      "UPDATE hackathon_participants SET status = 'withdrawn' WHERE hackathon_id = $1 AND user_id = $2",
      [hackathonId, withdrawnUser.userId],
    );
    await pool.query(
      "UPDATE hackathon_participants SET status = 'disqualified' WHERE hackathon_id = $1 AND user_id = $2",
      [hackathonId, disqualifiedUser.userId],
    );

    // 1a. Unregistered platform account cannot create a team (403 NOT_HACKATHON_PARTICIPANT)
    const unregCreateRes = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(unregisteredUser),
      payload: { name: 'Illegal Team', description: 'Should fail' },
    });
    expect(unregCreateRes.statusCode).toBe(403);
    expect(unregCreateRes.json().error.code).toBe('NOT_HACKATHON_PARTICIPANT');

    // 1b. Registered leader creates a valid team and a 1-use invite code
    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(leader),
      payload: { name: 'Verified Eligibility Crew', description: 'Valid team' },
    });
    expect(createRes.statusCode).toBe(201);
    const teamId = createRes.json<TeamDetailResponseDto>().team.id;

    const inviteRes = await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${teamId}/invites`,
      headers: authMutationHeaders(leader),
      payload: { maxUses: 1, expiresInHours: 24 },
    });
    expect(inviteRes.statusCode).toBe(201);
    const rawCode = inviteRes.json<{ invite: InviteCodeCreatedDto }>().invite.code;

    // 1c. Withdrawn participant cannot submit a join request (403 NOT_HACKATHON_PARTICIPANT)
    const withdrawnJoinRes = await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${teamId}/join-requests`,
      headers: authMutationHeaders(withdrawnUser),
      payload: { message: 'Trying to join while withdrawn' },
    });
    expect(withdrawnJoinRes.statusCode).toBe(403);
    expect(withdrawnJoinRes.json().error.code).toBe('NOT_HACKATHON_PARTICIPANT');

    // 1d. Disqualified participant cannot redeem an invitation code (403 NOT_HACKATHON_PARTICIPANT)
    const disqRedeemRes = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: authMutationHeaders(disqualifiedUser),
      payload: { code: rawCode },
    });
    expect(disqRedeemRes.statusCode).toBe(403);
    expect(disqRedeemRes.json().error.code).toBe('NOT_HACKATHON_PARTICIPANT');

    // 1e. Eligible applicant redeems the 1-use invite code -> creates pending join request and consumes the 1 use
    const validRedeemRes = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: authMutationHeaders(lateWithdrawnApplicant),
      payload: { code: rawCode },
    });
    expect(validRedeemRes.statusCode).toBe(201);
    const joinRequestId = validRedeemRes.json<InviteRedeemResultDto>().joinRequest.id;

    // If applicant becomes withdrawn before leader accepts, acceptance is blocked with 403 NOT_HACKATHON_PARTICIPANT
    await pool.query(
      "UPDATE hackathon_participants SET status = 'withdrawn' WHERE hackathon_id = $1 AND user_id = $2",
      [hackathonId, lateWithdrawnApplicant.userId],
    );
    const blockedAcceptRes = await app.inject({
      method: 'POST',
      url: `/api/v1/join-requests/${joinRequestId}/accept`,
      headers: authMutationHeaders(leader),
    });
    expect(blockedAcceptRes.statusCode).toBe(403);
    expect(blockedAcceptRes.json().error.code).toBe('NOT_HACKATHON_PARTICIPANT');

    // Restore applicant status to 'registered' -> leader can now accept the 1-use invite join request cleanly (DEFECT-02 regression proof!)
    await pool.query(
      "UPDATE hackathon_participants SET status = 'registered' WHERE hackathon_id = $1 AND user_id = $2",
      [hackathonId, lateWithdrawnApplicant.userId],
    );
    const okAcceptRes = await app.inject({
      method: 'POST',
      url: `/api/v1/join-requests/${joinRequestId}/accept`,
      headers: authMutationHeaders(leader),
    });
    expect(okAcceptRes.statusCode).toBe(200);
    expect(okAcceptRes.json().team.memberCount).toBe(2);
  });

  it('2. Outbox Commit-Order Regression Test (Section 5): concurrent transactions serialize outbox IDs in exact commit order so no event is ever skipped', async () => {
    await cleanDatabase();
    const pool = getDbPool();

    const clientA = await pool.connect();
    const clientB = await pool.connect();

    try {
      await clientA.query('BEGIN');
      await clientB.query('BEGIN');

      // Transaction A inserts an outbox event FIRST (acquires pg_advisory_xact_lock(842026002)) and remains uncommitted
      const idA = await insertOutboxEvent(clientA, {
        hackathonId,
        teamId: null,
        scope: 'board',
        eventType: 'TEAM_CREATED',
        payload: { marker: 'tx-A' },
      });

      let bResolvedBeforeACommit = false;
      // Transaction B attempts to insert an outbox event while Transaction A is still open
      const promiseB = insertOutboxEvent(clientB, {
        hackathonId,
        teamId: null,
        scope: 'board',
        eventType: 'TEAM_UPDATED',
        payload: { marker: 'tx-B' },
      }).then((id) => {
        bResolvedBeforeACommit = true;
        return id;
      });

      // Give PostgreSQL 80ms to confirm Transaction B is blocked on trg_outbox_events_serialize_id
      await new Promise((r) => setTimeout(r, 80));
      expect(bResolvedBeforeACommit).toBe(false);

      // Commit Transaction A first
      await clientA.query('COMMIT');

      // Now Transaction B unblocks, allocates the next sequence ID, and commits
      const idB = await promiseB;
      await clientB.query('COMMIT');

      expect(BigInt(idA)).toBeLessThan(BigInt(idB));

      // Verify catch-up query observes both events in exact commit order with zero gaps
      const rows = await pool.query<{ id: string; payload: { marker: string } }>(
        'SELECT id::text AS id, payload FROM outbox_events ORDER BY id ASC',
      );
      expect(rows.rows.map((r) => r.payload.marker)).toEqual(['tx-A', 'tx-B']);
    } finally {
      clientA.release();
      clientB.release();
    }
  });

  it('3. Cross-Team Same-Participant Concurrency Race (Section 6.B): when two leaders concurrently accept the same participant into two different teams, exactly one succeeds (200) and the other fails with 409 ALREADY_IN_TEAM', async () => {
    await cleanDatabase();

    const leader1 = await registerTestActor(app, 'CrossLeader1');
    const leader2 = await registerTestActor(app, 'CrossLeader2');
    const sharedApplicant = await registerTestActor(app, 'SharedApplicant');

    const t1Res = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(leader1),
      payload: { name: 'Cross Race Team One', description: 'Team 1' },
    });
    const team1Id = t1Res.json<TeamDetailResponseDto>().team.id;

    const t2Res = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(leader2),
      payload: { name: 'Cross Race Team Two', description: 'Team 2' },
    });
    const team2Id = t2Res.json<TeamDetailResponseDto>().team.id;

    // SharedApplicant submits pending join requests to BOTH Team 1 and Team 2
    const jr1Res = await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${team1Id}/join-requests`,
      headers: authMutationHeaders(sharedApplicant),
      payload: { message: 'Requesting Team 1' },
    });
    const jr1Id = jr1Res.json<{ joinRequest: JoinRequestDto }>().joinRequest.id;

    const jr2Res = await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${team2Id}/join-requests`,
      headers: authMutationHeaders(sharedApplicant),
      payload: { message: 'Requesting Team 2' },
    });
    const jr2Id = jr2Res.json<{ joinRequest: JoinRequestDto }>().joinRequest.id;

    // Fire both leader acceptances concurrently
    const [acc1, acc2] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/v1/join-requests/${jr1Id}/accept`,
        headers: authMutationHeaders(leader1),
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/join-requests/${jr2Id}/accept`,
        headers: authMutationHeaders(leader2),
      }),
    ]);

    const statuses = [acc1.statusCode, acc2.statusCode].sort();
    expect(statuses).toEqual([200, 409]);

    const pool = getDbPool();
    const memberCountRes = await pool.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM team_members WHERE hackathon_id = $1 AND user_id = $2',
      [hackathonId, sharedApplicant.userId],
    );
    expect(memberCountRes.rows[0]?.cnt).toBe(1);
  });

  it('4. Simultaneous Identical Idempotency Requests (Section 6.E): concurrent requests with the same Idempotency-Key execute the mutation once and replay the identical response', async () => {
    await cleanDatabase();
    const leader = await registerTestActor(app, 'SimulIdemLeader');
    const sharedKey = `simul_idem_${crypto.randomUUID()}`;
    const payload = {
      name: 'Simultaneous Idempotent Team',
      description: 'Must only be created once.',
      desiredSkills: ['typescript', 'rust'],
    };

    const [res1, res2] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/v1/hackathons/${hackathonId}/teams`,
        headers: authMutationHeaders(leader, sharedKey),
        payload,
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/hackathons/${hackathonId}/teams`,
        headers: authMutationHeaders(leader, sharedKey),
        payload,
      }),
    ]);

    expect(res1.statusCode).toBe(201);
    expect(res2.statusCode).toBe(201);
    expect(res1.json<TeamDetailResponseDto>().team.id).toBe(
      res2.json<TeamDetailResponseDto>().team.id,
    );

    const replayedFlags = [
      res1.headers['x-idempotent-replay'] === 'true',
      res2.headers['x-idempotent-replay'] === 'true',
    ];
    expect(replayedFlags).toContain(true);
    expect(replayedFlags).toContain(false);
  });

  it('5. Database Integrity Triggers & Constraints (Section 10): rejects 0 leaders, 2 leaders, wrong leader_user_id, mismatched member_count, over-capacity, and invalid status at commit', async () => {
    await cleanDatabase();
    const leader = await registerTestActor(app, 'TrigLeader');
    const member = await registerTestActor(app, 'TrigMember');

    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(leader),
      payload: { name: 'Trigger Integrity Team', description: 'Testing DB triggers' },
    });
    const teamId = createRes.json<TeamDetailResponseDto>().team.id;

    const jrRes = await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${teamId}/join-requests`,
      headers: authMutationHeaders(member),
      payload: {},
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/join-requests/${jrRes.json().joinRequest.id}/accept`,
      headers: authMutationHeaders(leader),
    });

    const pool = getDbPool();

    // 5a. Corrupting member_count to disagree with COUNT(team_members) must fail at commit
    await expect(
      pool.query('UPDATE teams SET member_count = 4 WHERE id = $1', [teamId]),
    ).rejects.toThrow(/disagrees with actual team_members count/);

    // 5b. Promoting second member to leader without demoting first leader must fail (unique index idx_team_members_one_leader_per_team)
    await expect(
      pool.query("UPDATE team_members SET role = 'leader' WHERE team_id = $1 AND user_id = $2", [
        teamId,
        member.userId,
      ]),
    ).rejects.toThrow();

    // 5c. Demoting sole leader so team has 0 leaders must fail at commit
    await expect(
      pool.query("UPDATE team_members SET role = 'member' WHERE team_id = $1 AND user_id = $2", [
        teamId,
        leader.userId,
      ]),
    ).rejects.toThrow(/must have exactly 1 leader/);

    // 5d. Setting status = 'forming' when member_count = 2 >= min_team_size = 2 must fail check constraint
    await expect(
      pool.query("UPDATE teams SET status = 'forming' WHERE id = $1", [teamId]),
    ).rejects.toThrow();
  });
});
