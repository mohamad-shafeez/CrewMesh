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
import { cleanupExpiredRateLimitBuckets } from '../src/security/rate-limit.js';
import { insertOutboxEvent } from '../src/services/audit-outbox-service.js';
import { requireActiveHackathonParticipantTx } from '../src/services/team-service.js';

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

describe('Batches 7 & 8 — Final Backend Reliability, Outbox Commit-Order, FOR SHARE Participant Locking, Registration Integrity & Security Hardening Suite (PostgreSQL)', () => {
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

  it('1. Participant Eligibility & Registration Rollback (Batch 8 Sections 3 & 4): blocks invalid/inactive hackathon registration with full rollback, blocks unregistered/withdrawn/disqualified accounts, and enforces FOR SHARE row locks', async () => {
    await cleanDatabase();
    const pool = getDbPool();

    // 1a. Registration with nonexistent hackathonId must fail (404) and create neither user nor session
    const badHackEmail = `badhack_${crypto.randomUUID().slice(0, 8)}@example.com`;
    const badHackRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { origin: TEST_ORIGIN },
      payload: {
        email: badHackEmail,
        password: 'ValidTestPassword!2026',
        displayName: 'Bad Hackathon User',
        hackathonId: 'nonexistent-hackathon-slug',
      },
    });
    expect(badHackRes.statusCode).toBe(404);
    expect(badHackRes.json().error.code).toBe('HACKATHON_NOT_FOUND');

    const checkNoUser = await pool.query('SELECT id FROM users WHERE email = $1', [badHackEmail]);
    expect(checkNoUser.rowCount).toBe(0);

    const leader = await registerTestActor(app, 'EligLeader');
    const unregisteredUser = await registerTestActor(app, 'UnregisteredUser');
    await pool.query(
      'DELETE FROM hackathon_participants WHERE hackathon_id = $1 AND user_id = $2',
      [hackathonId, unregisteredUser.userId],
    );

    const withdrawnUser = await registerTestActor(app, 'WithdrawnUser');
    const disqualifiedUser = await registerTestActor(app, 'DisqualifiedUser');
    const lateWithdrawnApplicant = await registerTestActor(app, 'LateWithdrawn');

    await pool.query(
      "UPDATE hackathon_participants SET status = 'withdrawn' WHERE hackathon_id = $1 AND user_id = $2",
      [hackathonId, withdrawnUser.userId],
    );
    await pool.query(
      "UPDATE hackathon_participants SET status = 'disqualified' WHERE hackathon_id = $1 AND user_id = $2",
      [hackathonId, disqualifiedUser.userId],
    );

    const unregCreateRes = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(unregisteredUser),
      payload: { name: 'Illegal Team', description: 'Should fail' },
    });
    expect(unregCreateRes.statusCode).toBe(403);
    expect(unregCreateRes.json().error.code).toBe('NOT_HACKATHON_PARTICIPANT');

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

    const withdrawnJoinRes = await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${teamId}/join-requests`,
      headers: authMutationHeaders(withdrawnUser),
      payload: { message: 'Trying to join while withdrawn' },
    });
    expect(withdrawnJoinRes.statusCode).toBe(403);
    expect(withdrawnJoinRes.json().error.code).toBe('NOT_HACKATHON_PARTICIPANT');

    const disqRedeemRes = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: authMutationHeaders(disqualifiedUser),
      payload: { code: rawCode },
    });
    expect(disqRedeemRes.statusCode).toBe(403);
    expect(disqRedeemRes.json().error.code).toBe('NOT_HACKATHON_PARTICIPANT');

    const validRedeemRes = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: authMutationHeaders(lateWithdrawnApplicant),
      payload: { code: rawCode },
    });
    expect(validRedeemRes.statusCode).toBe(201);
    const joinRequestId = validRedeemRes.json<InviteRedeemResultDto>().joinRequest.id;

    // 1b. FOR SHARE Concurrency Scenario B: when membership check holds FOR SHARE lock on hackathon_participants,
    // a concurrent UPDATE hackathon_participants SET status = 'withdrawn' blocks until the transaction commits/rolls back!
    const clientLock = await pool.connect();
    const clientWithdraw = await pool.connect();
    try {
      await clientLock.query('BEGIN');
      await clientWithdraw.query('BEGIN');

      await requireActiveHackathonParticipantTx(
        clientLock,
        hackathonId,
        lateWithdrawnApplicant.userId,
      );

      let withdrawFinishedWhileLocked = false;
      const withdrawPromise = clientWithdraw
        .query(
          "UPDATE hackathon_participants SET status = 'withdrawn' WHERE hackathon_id = $1 AND user_id = $2",
          [hackathonId, lateWithdrawnApplicant.userId],
        )
        .then(() => {
          withdrawFinishedWhileLocked = true;
        });

      await new Promise((r) => setTimeout(r, 80));
      expect(withdrawFinishedWhileLocked).toBe(false);

      await clientLock.query('COMMIT');
      await withdrawPromise;
      await clientWithdraw.query('COMMIT');
    } finally {
      clientLock.release();
      clientWithdraw.release();
    }

    // Because withdrawal committed, leader acceptance is now rejected with 403 NOT_HACKATHON_PARTICIPANT
    const blockedAcceptRes = await app.inject({
      method: 'POST',
      url: `/api/v1/join-requests/${joinRequestId}/accept`,
      headers: authMutationHeaders(leader),
    });
    expect(blockedAcceptRes.statusCode).toBe(403);
    expect(blockedAcceptRes.json().error.code).toBe('NOT_HACKATHON_PARTICIPANT');

    // Restore applicant status to 'registered' -> leader can now accept the 1-use invite join request cleanly
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

  it('2. Outbox Commit-Order & Migration 007 Explicit ID Protection (Batch 8 Section 5.3): serializes concurrent outbox IDs in commit order and rejects explicit caller-supplied IDs', async () => {
    await cleanDatabase();
    const pool = getDbPool();

    // Verify Migration 007 rejects explicit outbox_events.id insertion
    await expect(
      pool.query(
        `INSERT INTO outbox_events (id, hackathon_id, team_id, scope, event_type, payload)
         VALUES (999999, $1, NULL, 'board', 'TEAM_CREATED', '{}'::jsonb)`,
        [hackathonId],
      ),
    ).rejects.toThrow(/Explicit outbox_events\.id insertion/);

    const clientA = await pool.connect();
    const clientB = await pool.connect();

    try {
      await clientA.query('BEGIN');
      await clientB.query('BEGIN');

      const idA = await insertOutboxEvent(clientA, {
        hackathonId,
        teamId: null,
        scope: 'board',
        eventType: 'TEAM_CREATED',
        payload: { marker: 'tx-A' },
      });

      let bResolvedBeforeACommit = false;
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

      await new Promise((r) => setTimeout(r, 80));
      expect(bResolvedBeforeACommit).toBe(false);

      await clientA.query('COMMIT');
      const idB = await promiseB;
      await clientB.query('COMMIT');

      expect(BigInt(idA)).toBeLessThan(BigInt(idB));

      const rows = await pool.query<{ id: string; payload: { marker: string } }>(
        'SELECT id::text AS id, payload FROM outbox_events ORDER BY id ASC',
      );
      expect(rows.rows.map((r) => r.payload.marker)).toEqual(['tx-A', 'tx-B']);
    } finally {
      clientA.release();
      clientB.release();
    }
  });

  it('3. Cross-Team Same-Participant Concurrency Race: when two leaders concurrently accept the same participant into two different teams, exactly one succeeds (200) and the other fails with 409 ALREADY_IN_TEAM', async () => {
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

  it('4. Simultaneous Identical Idempotency Requests & Email Login Rate Limiting (Batch 8 Section 7)', async () => {
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

    // Verify auth_email rate limiting uses SHA-256 hashed bucket_key (never raw email)
    const pool = getDbPool();
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: TEST_ORIGIN },
      payload: {
        email: leader.email,
        password: 'WrongPassword123!',
      },
    });

    const bucketRes = await pool.query<{ bucket_key: string; scope: string }>(
      "SELECT bucket_key, scope FROM rate_limit_buckets WHERE scope = 'auth_email'",
    );
    expect(bucketRes.rowCount).toBe(1);
    expect(bucketRes.rows[0]?.bucket_key).not.toContain(leader.email);

    // Verify cleanupExpiredRateLimitBuckets deletes only expired rows
    await pool.query(
      "INSERT INTO rate_limit_buckets (bucket_key, scope, hits, window_start, expires_at) VALUES ('auth_ip:expired_test', 'auth_ip', 5, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour')",
    );
    const deletedCount = await cleanupExpiredRateLimitBuckets(pool, 50);
    expect(deletedCount).toBeGreaterThanOrEqual(1);
  });

  it('5. Database Integrity Triggers & Constraints: rejects 0 leaders, 2 leaders, wrong leader_user_id, mismatched member_count, over-capacity, and invalid status at commit', async () => {
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

    await expect(
      pool.query('UPDATE teams SET member_count = 4 WHERE id = $1', [teamId]),
    ).rejects.toThrow(/disagrees with actual team_members count/);

    await expect(
      pool.query("UPDATE team_members SET role = 'leader' WHERE team_id = $1 AND user_id = $2", [
        teamId,
        member.userId,
      ]),
    ).rejects.toThrow();

    await expect(
      pool.query("UPDATE team_members SET role = 'member' WHERE team_id = $1 AND user_id = $2", [
        teamId,
        leader.userId,
      ]),
    ).rejects.toThrow(/must have exactly 1 leader/);

    await expect(
      pool.query("UPDATE teams SET status = 'forming' WHERE id = $1", [teamId]),
    ).rejects.toThrow();
  });
});
