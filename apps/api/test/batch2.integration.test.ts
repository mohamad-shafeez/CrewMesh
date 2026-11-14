import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  InviteCodeCreatedDto,
  InviteCodeListResponse,
  InviteRedeemResultDto,
  JoinRequestDto,
  JoinRequestInboxPageResponse,
  TeamBoardPageResponse,
  TeamDetailResponseDto,
  TeamDetailsDto,
} from '@crewmesh/shared';
import { buildApp } from '../src/app.js';
import { resetEnvCache } from '../src/config/env.js';
import { runMigrationsUp } from '../src/db/migrate.js';
import { closeDbPool, getDbPool, withTransaction } from '../src/db/pool.js';
import { seedHackathon } from '../src/db/seed.js';
import type { LeaveTeamResultDto } from '../src/services/team-service.js';

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
  skills: string[] = ['typescript', 'postgresql'],
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
      skills,
      timezone: 'Asia/Kolkata',
    },
  });

  if (res.statusCode !== 201) {
    throw new Error(`Failed to register test actor ${label}: ${res.body}`);
  }

  const token = extractCookieValue(res.headers['set-cookie'], 'crewmesh_session');
  const body = res.json<{ user: { id: string; email: string }; csrfToken: string }>();

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

describe('Batch 2, 3 & 4 — Transactional Team Formation, Invite Approval & Integrity Suite (PostgreSQL)', () => {
  let app: FastifyInstance;
  let hackathonId: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.APP_ORIGIN = TEST_ORIGIN;
    process.env.CSRF_SECRET = 'batch2_test_csrf_secret_with_at_least_32_bytes_entropy_999';
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
    process.env.HACKATHON_DEADLINE_ISO = '';
    resetEnvCache();
    const seeded = await seedHackathon(pool);
    hackathonId = seeded.id;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    await closeDbPool();
  });

  it('1 & 2. Authenticated user creates a team and becomes its initial leader in forming status', async () => {
    const leader = await registerTestActor(app, 'LeaderOne');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(leader),
      payload: {
        name: 'Distributed Locks United',
        description: 'Building a race-proof team engine.',
        desiredSkills: ['TypeScript', 'PostgreSQL', 'React'],
      },
    });

    expect(res.statusCode).toBe(201);
    const { team } = res.json<{ team: TeamDetailsDto }>();
    expect(team.name).toBe('Distributed Locks United');
    expect(team.leaderUserId).toBe(leader.userId);
    expect(team.leader.userId).toBe(leader.userId);
    expect(team.leader.role).toBe('leader');
    expect(team.status).toBe('forming');
    expect(team.memberCount).toBe(1);
    expect(team.minTeamSize).toBe(2);
    expect(team.maxTeamSize).toBe(5);
    expect(team.availableSeats).toBe(4);
    expect(team.isFull).toBe(false);
    expect(team.members).toHaveLength(1);
    expect(team.desiredSkills).toEqual(['typescript', 'postgresql', 'react']);
  });

  it('3. Unauthenticated team creation is rejected with 401 UNAUTHORIZED', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: {
        origin: TEST_ORIGIN,
        'idempotency-key': `idem_${crypto.randomUUID()}`,
      },
      payload: {
        name: 'Ghost Team',
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');
  });

  it('4. Invalid team data and out-of-bounds team sizes are rejected', async () => {
    const actor = await registerTestActor(app, 'InvalidDataActor');

    const shortNameRes = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(actor),
      payload: {
        name: 'A',
      },
    });
    expect(shortNameRes.statusCode).toBe(400);
    expect(shortNameRes.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');

    const invalidSizeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(actor),
      payload: {
        name: 'Oversized Team',
        minTeamSize: 2,
        maxTeamSize: 10,
      },
    });
    expect(invalidSizeRes.statusCode).toBe(400);
    expect(invalidSizeRes.json<{ error: { code: string } }>().error.code).toBe('INVALID_TEAM_SIZE');
  });

  it('5. Duplicate team name in the same hackathon is rejected with 409 TEAM_NAME_ALREADY_EXISTS', async () => {
    const user1 = await registerTestActor(app, 'DupName1');
    const user2 = await registerTestActor(app, 'DupName2');

    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(user1),
      payload: { name: 'Unique Crew Name' },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(user2),
      payload: { name: 'Unique Crew Name' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: { code: string } }>().error.code).toBe('TEAM_NAME_ALREADY_EXISTS');
  });

  it('6. User cannot create two teams in the same hackathon (409 ALREADY_IN_TEAM)', async () => {
    const user = await registerTestActor(app, 'TwoTeamsUser');

    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(user),
      payload: { name: 'First Team' },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(user),
      payload: { name: 'Second Team' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: { code: string } }>().error.code).toBe('ALREADY_IN_TEAM');
  });

  it('7 & 8. Public board returns actual PostgreSQL records and supports keyset pagination & filters', async () => {
    const u1 = await registerTestActor(app, 'BoardU1');
    const u2 = await registerTestActor(app, 'BoardU2');
    const u3 = await registerTestActor(app, 'BoardU3');

    await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(u1),
      payload: { name: 'Team One', desiredSkills: ['rust', 'postgresql'] },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(u2),
      payload: { name: 'Team Two', desiredSkills: ['react', 'typescript'] },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(u3),
      payload: { name: 'Team Three', desiredSkills: ['rust', 'go'] },
    });

    const page1Res = await app.inject({
      method: 'GET',
      url: `/api/v1/hackathons/${hackathonId}/teams?limit=2`,
    });
    expect(page1Res.statusCode).toBe(200);
    const page1 = page1Res.json<TeamBoardPageResponse>();
    expect(page1.items).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeTruthy();

    const page2Res = await app.inject({
      method: 'GET',
      url: `/api/v1/hackathons/${hackathonId}/teams?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
    });
    expect(page2Res.statusCode).toBe(200);
    const page2 = page2Res.json<TeamBoardPageResponse>();
    expect(page2.items).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();

    const allIds = [...page1.items.map((i) => i.id), ...page2.items.map((i) => i.id)];
    expect(new Set(allIds).size).toBe(3);

    const skillRes = await app.inject({
      method: 'GET',
      url: `/api/v1/hackathons/${hackathonId}/teams?skill=rust`,
    });
    expect(skillRes.statusCode).toBe(200);
    expect(skillRes.json<TeamBoardPageResponse>().items).toHaveLength(2);
  });

  it('9. Team details endpoint returns accurate members, viewerContext for authenticated viewers, and omits sensitive user fields', async () => {
    const leader = await registerTestActor(app, 'DetailLeader');
    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(leader),
      payload: { name: 'Privacy Check Team' },
    });
    const teamId = createRes.json<{ team: TeamDetailsDto }>().team.id;

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/teams/${teamId}`,
    });
    expect(getRes.statusCode).toBe(200);
    const rawBody = getRes.body;
    expect(rawBody).not.toContain(leader.email);
    expect(rawBody).not.toContain('password_hash');

    const { team, viewerContext } = getRes.json<TeamDetailResponseDto>();
    expect(team.id).toBe(teamId);
    expect(team.members).toHaveLength(1);
    expect(team.members[0]?.userId).toBe(leader.userId);
    expect(team.members[0]?.role).toBe('leader');
    expect(viewerContext).toBeNull();

    // Authenticated request includes viewerContext
    const authGetRes = await app.inject({
      method: 'GET',
      url: `/api/v1/teams/${teamId}`,
      headers: { cookie: leader.cookie },
    });
    const authBody = authGetRes.json<TeamDetailResponseDto>();
    expect(authBody.viewerContext?.myTeamIdInHackathon).toBe(teamId);
    expect(authBody.viewerContext?.myRoleInTeam).toBe('leader');
  });

  it('10 & 11. User creates a join request and duplicate pending join requests are rejected', async () => {
    const leader = await registerTestActor(app, 'ReqLeader');
    const applicant = await registerTestActor(app, 'ReqApplicant');

    const teamRes = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(leader),
      payload: { name: 'Joinable Team' },
    });
    const teamId = teamRes.json<{ team: TeamDetailsDto }>().team.id;

    const req1 = await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${teamId}/join-requests`,
      headers: authMutationHeaders(applicant),
      payload: { message: 'I would love to join as backend engineer!' },
    });
    expect(req1.statusCode).toBe(201);
    const jr = req1.json<{ joinRequest: JoinRequestDto }>().joinRequest;
    expect(jr.status).toBe('pending');
    expect(jr.source).toBe('board');
    expect(jr.userId).toBe(applicant.userId);

    const req2 = await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${teamId}/join-requests`,
      headers: authMutationHeaders(applicant),
      payload: { message: 'Second pending request' },
    });
    expect(req2.statusCode).toBe(409);
    expect(req2.json<{ error: { code: string } }>().error.code).toBe('JOIN_REQUEST_ALREADY_EXISTS');
  });

  it('12 & 13. Non-leader cannot view the leader inbox or accept/decline a join request', async () => {
    const leader = await registerTestActor(app, 'InboxLeader');
    const applicant = await registerTestActor(app, 'InboxApplicant');
    const outsider = await registerTestActor(app, 'InboxOutsider');

    const teamId = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/hackathons/${hackathonId}/teams`,
        headers: authMutationHeaders(leader),
        payload: { name: 'Protected Inbox Team' },
      })
    ).json<{ team: TeamDetailsDto }>().team.id;

    const reqId = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/teams/${teamId}/join-requests`,
        headers: authMutationHeaders(applicant),
        payload: { message: 'Let me in' },
      })
    ).json<{ joinRequest: JoinRequestDto }>().joinRequest.id;

    const outsiderInbox = await app.inject({
      method: 'GET',
      url: `/api/v1/teams/${teamId}/join-requests`,
      headers: { cookie: outsider.cookie },
    });
    expect(outsiderInbox.statusCode).toBe(403);
    expect(outsiderInbox.json<{ error: { code: string } }>().error.code).toBe(
      'UNAUTHORIZED_TEAM_ACTION',
    );

    const outsiderAccept = await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${teamId}/join-requests/${reqId}/accept`,
      headers: authMutationHeaders(outsider),
    });
    expect(outsiderAccept.statusCode).toBe(403);
    expect(outsiderAccept.json<{ error: { code: string } }>().error.code).toBe(
      'UNAUTHORIZED_TEAM_ACTION',
    );

    const leaderInbox = await app.inject({
      method: 'GET',
      url: `/api/v1/teams/${teamId}/join-requests`,
      headers: { cookie: leader.cookie },
    });
    expect(leaderInbox.statusCode).toBe(200);
    expect(leaderInbox.json<JoinRequestInboxPageResponse>().items).toHaveLength(1);
  });

  it('14, 15 & 16. Leader accepts request (transitioning forming -> ready), declines request, and full team rejects further accepts', async () => {
    const leader = await registerTestActor(app, 'AccLeader');
    const cand1 = await registerTestActor(app, 'Cand1');
    const cand2 = await registerTestActor(app, 'Cand2');
    const cand3 = await registerTestActor(app, 'Cand3');

    const teamId = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/hackathons/${hackathonId}/teams`,
        headers: authMutationHeaders(leader),
        payload: {
          name: 'Two Seat Team',
          minTeamSize: 2,
          maxTeamSize: 2,
        },
      })
    ).json<{ team: TeamDetailsDto }>().team.id;

    const req1Id = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/teams/${teamId}/join-requests`,
        headers: authMutationHeaders(cand1),
      })
    ).json<{ joinRequest: JoinRequestDto }>().joinRequest.id;

    const req2Id = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/teams/${teamId}/join-requests`,
        headers: authMutationHeaders(cand2),
      })
    ).json<{ joinRequest: JoinRequestDto }>().joinRequest.id;

    const req3Id = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/teams/${teamId}/join-requests`,
        headers: authMutationHeaders(cand3),
      })
    ).json<{ joinRequest: JoinRequestDto }>().joinRequest.id;

    const declineRes = await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${teamId}/join-requests/${req1Id}/decline`,
      headers: authMutationHeaders(leader),
    });
    expect(declineRes.statusCode).toBe(200);
    expect(declineRes.json<{ joinRequest: JoinRequestDto }>().joinRequest.status).toBe('declined');

    const acceptRes = await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${teamId}/join-requests/${req2Id}/accept`,
      headers: authMutationHeaders(leader),
    });
    expect(acceptRes.statusCode).toBe(200);
    const acceptedBody = acceptRes.json<{ joinRequest: JoinRequestDto; team: TeamDetailsDto }>();
    expect(acceptedBody.joinRequest.status).toBe('accepted');
    expect(acceptedBody.team.memberCount).toBe(2);
    expect(acceptedBody.team.status).toBe('ready');
    expect(acceptedBody.team.isFull).toBe(true);

    const fullRes = await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${teamId}/join-requests/${req3Id}/accept`,
      headers: authMutationHeaders(leader),
    });
    expect(fullRes.statusCode).toBe(409);
    expect(fullRes.json<{ error: { code: string } }>().error.code).toBe('JOIN_REQUEST_ALREADY_PROCESSED');
  });

  it('17, 18, 19, 20 & 36. Invitation creation, leader GET /invites metadata list, redemption into pending join request, expiry, revocation, and max-use enforcement', async () => {
    const leader = await registerTestActor(app, 'InvLeader');
    const redeemer1 = await registerTestActor(app, 'Redeemer1');
    const redeemer2 = await registerTestActor(app, 'Redeemer2');
    const redeemer3 = await registerTestActor(app, 'Redeemer3');

    const teamId = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/hackathons/${hackathonId}/teams`,
        headers: authMutationHeaders(leader),
        payload: { name: 'Invite Approval Team', minTeamSize: 2, maxTeamSize: 4 },
      })
    ).json<{ team: TeamDetailsDto }>().team.id;

    const createInvRes = await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${teamId}/invites`,
      headers: authMutationHeaders(leader),
      payload: { maxUses: 2, expiresInHours: 24 },
    });
    expect(createInvRes.statusCode).toBe(201);
    const invite = createInvRes.json<{ invite: InviteCodeCreatedDto }>().invite;
    expect(invite.code.length).toBeGreaterThanOrEqual(43);

    // 36: Non-leader cannot list team invites; leader can list metadata without raw code or token_hash
    const nonLeaderList = await app.inject({
      method: 'GET',
      url: `/api/v1/teams/${teamId}/invites`,
      headers: { cookie: redeemer1.cookie },
    });
    expect(nonLeaderList.statusCode).toBe(403);

    const leaderListRes = await app.inject({
      method: 'GET',
      url: `/api/v1/teams/${teamId}/invites`,
      headers: { cookie: leader.cookie },
    });
    expect(leaderListRes.statusCode).toBe(200);
    expect(leaderListRes.body).not.toContain(invite.code);
    expect(leaderListRes.body).not.toContain('token_hash');
    const listedInvites = leaderListRes.json<InviteCodeListResponse>().invites;
    expect(listedInvites).toHaveLength(1);
    expect(listedInvites[0]?.id).toBe(invite.id);
    expect(listedInvites[0]?.tokenPrefix).toBe(invite.tokenPrefix);
    expect(listedInvites[0]?.maxUses).toBe(2);
    expect(listedInvites[0]?.useCount).toBe(0);
    expect(listedInvites[0]?.isRevoked).toBe(false);

    const pool = getDbPool();
    const rawCheck = await pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM invite_codes WHERE id = $1',
      [invite.id],
    );
    expect(rawCheck.rows[0]?.token_hash).not.toBe(invite.code);
    expect(rawCheck.rows[0]?.token_hash).toHaveLength(64);

    // Redeemer 1 redeems the invite -> creates a PENDING join request (does NOT add to team_members!)
    const redeem1IdemKey = `idem_redeem1_${crypto.randomUUID()}`;
    const redeem1Res = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: authMutationHeaders(redeemer1, redeem1IdemKey),
      payload: { code: invite.code, message: 'Invited backend dev' },
    });
    expect(redeem1Res.statusCode).toBe(201);
    const redeem1Body = redeem1Res.json<InviteRedeemResultDto>();
    expect(redeem1Body.joinRequest.status).toBe('pending');
    expect(redeem1Body.joinRequest.source).toBe('invite_code');
    expect(redeem1Body.joinRequest.inviteCodeId).toBe(invite.id);

    const teamBeforeAccept = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/teams/${teamId}`,
      })
    ).json<{ team: TeamDetailsDto }>().team;
    expect(teamBeforeAccept.memberCount).toBe(1);

    const redeem1Retry = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: authMutationHeaders(redeemer1, redeem1IdemKey),
      payload: { code: invite.code, message: 'Invited backend dev' },
    });
    expect(redeem1Retry.statusCode).toBe(201);
    expect(redeem1Retry.headers['x-idempotent-replay']).toBe('true');

    const duplicateRedeem = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: authMutationHeaders(redeemer1),
      payload: { code: invite.code, message: 'Trying again' },
    });
    expect(duplicateRedeem.statusCode).toBe(409);
    expect(duplicateRedeem.json<{ error: { code: string } }>().error.code).toBe(
      'JOIN_REQUEST_ALREADY_EXISTS',
    );

    const usesAfterDuplicate = await pool.query<{ use_count: number }>(
      'SELECT use_count FROM invite_codes WHERE id = $1',
      [invite.id],
    );
    expect(usesAfterDuplicate.rows[0]?.use_count).toBe(1);

    const redeem2Res = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: authMutationHeaders(redeemer2),
      payload: { code: invite.code },
    });
    expect(redeem2Res.statusCode).toBe(201);
    const jr2Id = redeem2Res.json<InviteRedeemResultDto>().joinRequest.id;

    const declineJr2 = await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${teamId}/join-requests/${jr2Id}/decline`,
      headers: authMutationHeaders(leader),
    });
    expect(declineJr2.statusCode).toBe(200);

    const redeem3Res = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: authMutationHeaders(redeemer3),
      payload: { code: invite.code },
    });
    expect(redeem3Res.statusCode).toBe(409);
    expect(redeem3Res.json<{ error: { code: string } }>().error.code).toBe(
      'INVITE_MAX_USES_REACHED',
    );

    const acceptJr1 = await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${teamId}/join-requests/${redeem1Body.joinRequest.id}/accept`,
      headers: authMutationHeaders(leader),
    });
    expect(acceptJr1.statusCode).toBe(200);
    expect(acceptJr1.json<{ team: TeamDetailsDto }>().team.memberCount).toBe(2);

    const finalUses = await pool.query<{ use_count: number }>(
      'SELECT use_count FROM invite_codes WHERE id = $1',
      [invite.id],
    );
    expect(finalUses.rows[0]?.use_count).toBe(2);

    const expiredInvRes = await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${teamId}/invites`,
      headers: authMutationHeaders(leader),
      payload: { expiresAt: new Date(Date.now() - 60_000).toISOString() },
    });
    const expiredCode = expiredInvRes.json<{ invite: InviteCodeCreatedDto }>().invite.code;

    const redeemExpired = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: authMutationHeaders(redeemer3),
      payload: { code: expiredCode },
    });
    expect(redeemExpired.statusCode).toBe(410);
    expect(redeemExpired.json<{ error: { code: string } }>().error.code).toBe('INVITE_EXPIRED');

    const revocableInv = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/teams/${teamId}/invites`,
        headers: authMutationHeaders(leader),
        payload: { expiresInHours: 12 },
      })
    ).json<{ invite: InviteCodeCreatedDto }>().invite;

    const revokeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${teamId}/invites/${revocableInv.id}/revoke`,
      headers: authMutationHeaders(leader),
    });
    expect(revokeRes.statusCode).toBe(200);

    const redeemRevoked = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: authMutationHeaders(redeemer3),
      payload: { code: revocableInv.code },
    });
    expect(redeemRevoked.statusCode).toBe(410);
    expect(redeemRevoked.json<{ error: { code: string } }>().error.code).toBe('INVITE_REVOKED');
  });

  it('21, 22, 23, 24, 25 & 26. Member removal, member leave, deterministic leader succession, last-member team deletion, and surviving audit history', async () => {
    const leader = await registerTestActor(app, 'LifeLeader');
    const m1 = await registerTestActor(app, 'LifeM1');
    const m2 = await registerTestActor(app, 'LifeM2');
    const m3 = await registerTestActor(app, 'LifeM3');

    const teamId = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/hackathons/${hackathonId}/teams`,
        headers: authMutationHeaders(leader),
        payload: { name: 'Lifecycle Team', minTeamSize: 2, maxTeamSize: 5 },
      })
    ).json<{ team: TeamDetailsDto }>().team.id;

    const invCode = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/teams/${teamId}/invites`,
        headers: authMutationHeaders(leader),
        payload: { maxUses: 10 },
      })
    ).json<{ invite: InviteCodeCreatedDto }>().invite.code;

    for (const member of [m1, m2, m3]) {
      const redeemRes = await app.inject({
        method: 'POST',
        url: '/api/v1/invites/redeem',
        headers: authMutationHeaders(member),
        payload: { code: invCode },
      });
      const jrId = redeemRes.json<InviteRedeemResultDto>().joinRequest.id;
      const accRes = await app.inject({
        method: 'POST',
        url: `/api/v1/teams/${teamId}/join-requests/${jrId}/accept`,
        headers: authMutationHeaders(leader),
      });
      expect(accRes.statusCode).toBe(200);
    }

    const unauthRemove = await app.inject({
      method: 'DELETE',
      url: `/api/v1/teams/${teamId}/members/${m2.userId}`,
      headers: authMutationHeaders(m1),
    });
    expect(unauthRemove.statusCode).toBe(403);

    const selfRemove = await app.inject({
      method: 'DELETE',
      url: `/api/v1/teams/${teamId}/members/${leader.userId}`,
      headers: authMutationHeaders(leader),
    });
    expect(selfRemove.statusCode).toBe(409);
    expect(selfRemove.json<{ error: { code: string } }>().error.code).toBe('LEADER_MUST_USE_LEAVE');

    const removeM3 = await app.inject({
      method: 'DELETE',
      url: `/api/v1/teams/${teamId}/members/${m3.userId}`,
      headers: authMutationHeaders(leader),
    });
    expect(removeM3.statusCode).toBe(200);
    expect(removeM3.json<{ team: TeamDetailsDto }>().team.memberCount).toBe(3);

    const leaderLeave = await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${teamId}/leave`,
      headers: authMutationHeaders(leader),
    });
    expect(leaderLeave.statusCode).toBe(200);
    const leaderLeaveBody = leaderLeave.json<LeaveTeamResultDto>();
    expect(leaderLeaveBody.teamDeleted).toBe(false);
    expect(leaderLeaveBody.newLeaderUserId).toBe(m1.userId);
    expect(leaderLeaveBody.team?.leaderUserId).toBe(m1.userId);
    expect(leaderLeaveBody.team?.memberCount).toBe(2);
    expect(leaderLeaveBody.team?.status).toBe('ready');

    const m2Leave = await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${teamId}/leave`,
      headers: authMutationHeaders(m2),
    });
    expect(m2Leave.statusCode).toBe(200);
    const m2LeaveBody = m2Leave.json<LeaveTeamResultDto>();
    expect(m2LeaveBody.teamDeleted).toBe(false);
    expect(m2LeaveBody.team?.memberCount).toBe(1);
    expect(m2LeaveBody.team?.status).toBe('forming');

    const lastLeave = await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${teamId}/leave`,
      headers: authMutationHeaders(m1),
    });
    expect(lastLeave.statusCode).toBe(200);
    const lastLeaveBody = lastLeave.json<LeaveTeamResultDto>();
    expect(lastLeaveBody.teamDeleted).toBe(true);
    expect(lastLeaveBody.team).toBeNull();

    const getDeleted = await app.inject({
      method: 'GET',
      url: `/api/v1/teams/${teamId}`,
    });
    expect(getDeleted.statusCode).toBe(404);

    const pool = getDbPool();
    const auditRes = await pool.query<{ action: string }>(
      'SELECT action FROM audit_log WHERE team_id = $1 ORDER BY id ASC',
      [teamId],
    );
    const actions = auditRes.rows.map((r) => r.action);
    expect(actions).toContain('TEAM_CREATED');
    expect(actions).toContain('INVITE_CREATED');
    expect(actions).toContain('INVITE_REDEEMED');
    expect(actions).toContain('JOIN_REQUEST_CREATED');
    expect(actions).toContain('JOIN_REQUEST_ACCEPTED');
    expect(actions).toContain('MEMBER_REMOVED');
    expect(actions).toContain('LEADER_SUCCESSION');
    expect(actions).toContain('MEMBER_LEFT');
    expect(actions).toContain('TEAM_DELETED');

    const outboxRes = await pool.query<{ event_type: string }>(
      'SELECT event_type FROM outbox_events WHERE team_id = $1 ORDER BY id ASC',
      [teamId],
    );
    expect(outboxRes.rows.length).toBeGreaterThanOrEqual(8);
  });

  it('28, 29, 30 & 35. HTTP-level Idempotency works for both team creation and membership acceptance (concurrent retries, sequential replay, and payload mismatch rejection)', async () => {
    const leader = await registerTestActor(app, 'IdemLeader');
    const applicant = await registerTestActor(app, 'IdemApplicant');
    const sharedTeamKey = `idem_team_${crypto.randomUUID()}`;

    const [sim1, sim2] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/v1/hackathons/${hackathonId}/teams`,
        headers: authMutationHeaders(leader, sharedTeamKey),
        payload: { name: 'Idempotent Crew', description: 'Same payload' },
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/hackathons/${hackathonId}/teams`,
        headers: authMutationHeaders(leader, sharedTeamKey),
        payload: { name: 'Idempotent Crew', description: 'Same payload' },
      }),
    ]);

    expect(sim1.statusCode).toBe(201);
    expect(sim2.statusCode).toBe(201);
    const teamId = sim1.json<{ team: TeamDetailsDto }>().team.id;
    expect(sim2.json<{ team: TeamDetailsDto }>().team.id).toBe(teamId);

    const replayRes = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(leader, sharedTeamKey),
      payload: { name: 'Idempotent Crew', description: 'Same payload' },
    });
    expect(replayRes.statusCode).toBe(201);
    expect(replayRes.headers['x-idempotent-replay']).toBe('true');

    const conflictRes = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(leader, sharedTeamKey),
      payload: { name: 'Modified Crew Name', description: 'Different payload' },
    });
    expect(conflictRes.statusCode).toBe(409);
    expect(conflictRes.json<{ error: { code: string } }>().error.code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );

    const jrId = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/teams/${teamId}/join-requests`,
        headers: authMutationHeaders(applicant),
      })
    ).json<{ joinRequest: JoinRequestDto }>().joinRequest.id;

    const sharedAcceptKey = `idem_accept_${crypto.randomUUID()}`;
    const [acc1, acc2] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/v1/teams/${teamId}/join-requests/${jrId}/accept`,
        headers: authMutationHeaders(leader, sharedAcceptKey),
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/teams/${teamId}/join-requests/${jrId}/accept`,
        headers: authMutationHeaders(leader, sharedAcceptKey),
      }),
    ]);

    expect(acc1.statusCode).toBe(200);
    expect(acc2.statusCode).toBe(200);

    const pool = getDbPool();
    const memberCountRes = await pool.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM team_members WHERE team_id = $1 AND user_id = $2',
      [teamId, applicant.userId],
    );
    expect(memberCountRes.rows[0]?.cnt).toBe(1);

    const auditCountRes = await pool.query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM audit_log WHERE team_id = $1 AND action = 'JOIN_REQUEST_ACCEPTED'",
      [teamId],
    );
    expect(auditCountRes.rows[0]?.cnt).toBe(1);

    const outboxCountRes = await pool.query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM outbox_events WHERE team_id = $1 AND event_type = 'JOIN_REQUEST_ACCEPTED'",
      [teamId],
    );
    expect(outboxCountRes.rows[0]?.cnt).toBe(1);
  });

  it('31 & 32. Stored member_count always matches COUNT(*) in team_members, and cross-team concurrent accepts for the same user are prevented', async () => {
    const leaderA = await registerTestActor(app, 'CrossLeaderA');
    const leaderB = await registerTestActor(app, 'CrossLeaderB');
    const applicant = await registerTestActor(app, 'CrossApplicant');

    const teamAId = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/hackathons/${hackathonId}/teams`,
        headers: authMutationHeaders(leaderA),
        payload: { name: 'Cross Team A' },
      })
    ).json<{ team: TeamDetailsDto }>().team.id;

    const teamBId = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/hackathons/${hackathonId}/teams`,
        headers: authMutationHeaders(leaderB),
        payload: { name: 'Cross Team B' },
      })
    ).json<{ team: TeamDetailsDto }>().team.id;

    const reqAId = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/teams/${teamAId}/join-requests`,
        headers: authMutationHeaders(applicant),
      })
    ).json<{ joinRequest: JoinRequestDto }>().joinRequest.id;

    const reqBId = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/teams/${teamBId}/join-requests`,
        headers: authMutationHeaders(applicant),
      })
    ).json<{ joinRequest: JoinRequestDto }>().joinRequest.id;

    const [accA, accB] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/v1/teams/${teamAId}/join-requests/${reqAId}/accept`,
        headers: authMutationHeaders(leaderA),
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/teams/${teamBId}/join-requests/${reqBId}/accept`,
        headers: authMutationHeaders(leaderB),
      }),
    ]);

    const statuses = [accA.statusCode, accB.statusCode].sort();
    expect(statuses).toEqual([200, 409]);

    const pool = getDbPool();
    const userMemberships = await pool.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM team_members WHERE hackathon_id = $1 AND user_id = $2',
      [hackathonId, applicant.userId],
    );
    expect(userMemberships.rows[0]?.cnt).toBe(1);

    const mismatchRes = await pool.query<{ id: string }>(
      `
      SELECT t.id
      FROM teams t
      LEFT JOIN team_members tm ON tm.team_id = t.id
      GROUP BY t.id, t.member_count
      HAVING t.member_count <> COUNT(tm.id)
      `,
    );
    expect(mismatchRes.rows).toHaveLength(0);
  });

  it('33. Absent (NULL) vs configured hackathon registration deadline behaviour', async () => {
    const pool = getDbPool();
    const currentRes = await app.inject({
      method: 'GET',
      url: '/api/v1/hackathons/current',
    });
    expect(currentRes.statusCode).toBe(200);
    expect(
      currentRes.json<{ hackathon: { registrationDeadline: string | null } }>().hackathon
        .registrationDeadline,
    ).toBeNull();

    const actor = await registerTestActor(app, 'DeadlineActor');

    await pool.query(
      "UPDATE hackathons SET registration_deadline = NOW() - INTERVAL '1 hour' WHERE id = $1",
      [hackathonId],
    );
    const closedRes = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(actor),
      payload: { name: 'After Cutoff Team' },
    });
    expect(closedRes.statusCode).toBe(409);
    expect(closedRes.json<{ error: { code: string } }>().error.code).toBe(
      'HACKATHON_REGISTRATION_CLOSED',
    );

    await pool.query(
      "UPDATE hackathons SET registration_deadline = NOW() + INTERVAL '24 hours' WHERE id = $1",
      [hackathonId],
    );
    const openRes = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(actor),
      payload: { name: 'Before Cutoff Team' },
    });
    expect(openRes.statusCode).toBe(201);
  });

  it('34. Explicit database integrity tests reject invalid committed states (counter mismatch, leader mismatch, 0 leaders, 2 leaders, invalid status, over-capacity)', async () => {
    const leader = await registerTestActor(app, 'IntegrityLeader');
    const member = await registerTestActor(app, 'IntegrityMember');

    const teamId = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/hackathons/${hackathonId}/teams`,
        headers: authMutationHeaders(leader),
        payload: { name: 'DB Integrity Team', minTeamSize: 2, maxTeamSize: 2 },
      })
    ).json<{ team: TeamDetailsDto }>().team.id;

    await expect(
      withTransaction(async (client) => {
        await client.query(
          "UPDATE teams SET member_count = 2, status = 'ready' WHERE id = $1",
          [teamId],
        );
      }),
    ).rejects.toThrow(/member_count|check_violation/i);

    await expect(
      withTransaction(async (client) => {
        await client.query('UPDATE teams SET leader_user_id = $2 WHERE id = $1', [
          teamId,
          member.userId,
        ]);
      }),
    ).rejects.toThrow(/leader_user_id|check_violation/i);

    await expect(
      withTransaction(async (client) => {
        await client.query(
          "UPDATE team_members SET role = 'member' WHERE team_id = $1",
          [teamId],
        );
      }),
    ).rejects.toThrow(/exactly 1 leader|check_violation/i);

    await expect(
      withTransaction(async (client) => {
        await client.query(
          `INSERT INTO team_members (team_id, hackathon_id, user_id, role)
           VALUES ($1, $2, $3, 'leader')`,
          [teamId, hackathonId, member.userId],
        );
      }),
    ).rejects.toThrow();

    await expect(
      withTransaction(async (client) => {
        await client.query('UPDATE teams SET member_count = 3 WHERE id = $1', [teamId]);
      }),
    ).rejects.toThrow();
  });
});
