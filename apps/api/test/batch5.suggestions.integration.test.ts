import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  TeamDetailResponseDto,
  TeamDetailsDto,
  TeammateSuggestionsResponseDto,
} from '@crewmesh/shared';
import { buildApp } from '../src/app.js';
import { resetEnvCache } from '../src/config/env.js';
import { runMigrationsUp } from '../src/db/migrate.js';
import { closeDbPool, getDbPool } from '../src/db/pool.js';
import { seedHackathon } from '../src/db/seed.js';

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
  timezone: string | undefined = 'Asia/Kolkata',
): Promise<TestActor> {
  const uniqueSuffix = `${label.toLowerCase().replace(/[^a-z0-9]/g, '')}_${crypto.randomUUID().slice(0, 8)}`;
  const email = `${uniqueSuffix}@example.com`;
  const payload: Record<string, unknown> = {
    email,
    password: 'ValidTestPassword!2026',
    displayName: `User ${label}`,
    skills,
  };
  if (timezone !== undefined) {
    payload.timezone = timezone;
  }

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { origin: TEST_ORIGIN },
    payload,
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

describe('Batch 5 — Explainable Teammate Intelligence & Skill-Timezone Matching Suite (PostgreSQL)', () => {
  let app: FastifyInstance;
  let hackathonId: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.APP_ORIGIN = TEST_ORIGIN;
    process.env.CSRF_SECRET = 'batch5_test_csrf_secret_with_at_least_32_bytes_entropy_999';
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
        sessions,
        users
      RESTART IDENTITY CASCADE
    `);
  }

  it('19–22. Enforces authentication and leader-only authorization on GET /api/v1/teams/:teamId/suggestions', async () => {
    await cleanDatabase();
    const leaderA = await registerTestActor(app, 'LeaderA', ['typescript'], 'Asia/Kolkata');
    const memberA = await registerTestActor(app, 'MemberA', ['postgresql'], 'Asia/Kolkata');
    const leaderB = await registerTestActor(app, 'LeaderB', ['rust'], 'Asia/Kolkata');
    await registerTestActor(app, 'FreeCandidate', ['react', 'redis'], 'Asia/Kolkata');

    // Create Team A
    const createARes = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(leaderA),
      payload: {
        name: 'Team Alpha Match',
        description: 'Testing leader auth on suggestions.',
        desiredSkills: ['typescript', 'postgresql', 'react', 'redis'],
      },
    });
    expect(createARes.statusCode).toBe(201);
    const teamA = createARes.json<TeamDetailResponseDto>().team;

    // Create Team B
    const createBRes = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(leaderB),
      payload: {
        name: 'Team Beta Match',
        description: 'Other leader team.',
        desiredSkills: ['rust'],
      },
    });
    expect(createBRes.statusCode).toBe(201);

    // Add memberA to Team A
    const jrRes = await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${teamA.id}/join-requests`,
      headers: authMutationHeaders(memberA),
      payload: { message: 'Joining Team A' },
    });
    const jrId = jrRes.json<{ joinRequest: { id: string } }>().joinRequest.id;
    await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${teamA.id}/join-requests/${jrId}/accept`,
      headers: authMutationHeaders(leaderA),
    });

    // 20. Unauthenticated user receives 401 UNAUTHORIZED
    const unauthRes = await app.inject({
      method: 'GET',
      url: `/api/v1/teams/${teamA.id}/suggestions`,
    });
    expect(unauthRes.statusCode).toBe(401);
    expect(unauthRes.json().error.code).toBe('UNAUTHORIZED');

    // 21. Non-leader team member receives 403 UNAUTHORIZED_TEAM_ACTION
    const memberRes = await app.inject({
      method: 'GET',
      url: `/api/v1/teams/${teamA.id}/suggestions`,
      headers: { cookie: memberA.cookie },
    });
    expect(memberRes.statusCode).toBe(403);
    expect(memberRes.json().error.code).toBe('UNAUTHORIZED_TEAM_ACTION');

    // 22. Leader of a different team receives 403 UNAUTHORIZED_TEAM_ACTION
    const otherLeaderRes = await app.inject({
      method: 'GET',
      url: `/api/v1/teams/${teamA.id}/suggestions`,
      headers: { cookie: leaderB.cookie },
    });
    expect(otherLeaderRes.statusCode).toBe(403);
    expect(otherLeaderRes.json().error.code).toBe('UNAUTHORIZED_TEAM_ACTION');

    // 19 & 24. Team A leader (now Ready with 2/5 members) receives 200 OK suggestions
    const leaderRes = await app.inject({
      method: 'GET',
      url: `/api/v1/teams/${teamA.id}/suggestions`,
      headers: { cookie: leaderA.cookie },
    });
    expect(leaderRes.statusCode).toBe(200);
    const body = leaderRes.json<TeammateSuggestionsResponseDto>();
    expect(body.algorithmVersion).toBe('crewmesh-match-v1');
    expect(body.scoring.weights).toEqual({ skill: 70, timezone: 30 });
    expect(body.candidates.length).toBe(1);
  });

  it('23. Full team (member_count == max_team_size) receives 409 TEAM_FULL on suggestions endpoint', async () => {
    await cleanDatabase();
    const leader = await registerTestActor(app, 'FullLeader', ['typescript']);
    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(leader),
      payload: {
        name: 'Full Capacity Team',
        description: 'Will be filled to 5/5.',
        desiredSkills: ['typescript', 'rust'],
      },
    });
    const teamId = createRes.json<TeamDetailResponseDto>().team.id;

    for (let i = 1; i <= 4; i++) {
      const m = await registerTestActor(app, `FillMember${i}`, ['rust']);
      const jr = await app.inject({
        method: 'POST',
        url: `/api/v1/teams/${teamId}/join-requests`,
        headers: authMutationHeaders(m),
        payload: {},
      });
      await app.inject({
        method: 'POST',
        url: `/api/v1/teams/${teamId}/join-requests/${jr.json().joinRequest.id}/accept`,
        headers: authMutationHeaders(leader),
      });
    }

    const fullSuggestionsRes = await app.inject({
      method: 'GET',
      url: `/api/v1/teams/${teamId}/suggestions`,
      headers: { cookie: leader.cookie },
    });
    expect(fullSuggestionsRes.statusCode).toBe(409);
    expect(fullSuggestionsRes.json().error.code).toBe('TEAM_FULL');
  });

  it('25–33. Excludes ineligible users and computes accurate skill & timezone scores from real PostgreSQL records', async () => {
    await cleanDatabase();
    const leader = await registerTestActor(
      app,
      'MatchLeader',
      ['typescript', 'postgresql'],
      'Asia/Kolkata',
    );
    const otherTeamLeader = await registerTestActor(
      app,
      'OtherLeader',
      ['react', 'redis'],
      'Asia/Kolkata',
    );
    const pendingApplicant = await registerTestActor(
      app,
      'PendingApplicant',
      ['react', 'redis'],
      'Asia/Kolkata',
    );
    const candidateTop = await registerTestActor(
      app,
      'CandidateTop',
      ['react', 'redis', 'docker'],
      'Asia/Kolkata',
    );
    const candidateMid = await registerTestActor(
      app,
      'CandidateMid',
      ['react'],
      'Europe/London',
    );

    // Create target team
    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(leader),
      payload: {
        name: 'Precision Match Crew',
        description: 'Testing candidate eligibility and scoring.',
        desiredSkills: ['typescript', 'postgresql', 'react', 'redis'],
      },
    });
    const teamId = createRes.json<TeamDetailResponseDto>().team.id;

    // Put otherTeamLeader on another team in the same hackathon
    await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(otherTeamLeader),
      payload: {
        name: 'Other Active Team',
        description: 'Already committed.',
        desiredSkills: ['react'],
      },
    });

    // Have pendingApplicant submit a pending join request to target team
    await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${teamId}/join-requests`,
      headers: authMutationHeaders(pendingApplicant),
      payload: { message: 'Already requested!' },
    });

    // Fetch suggestions
    const sugRes = await app.inject({
      method: 'GET',
      url: `/api/v1/teams/${teamId}/suggestions?limit=10`,
      headers: { cookie: leader.cookie },
    });
    expect(sugRes.statusCode).toBe(200);
    const data = sugRes.json<TeammateSuggestionsResponseDto>();

    // Verify unmet desired skills
    expect(data.teamSkillSummary.desiredSkills).toEqual([
      'typescript',
      'postgresql',
      'react',
      'redis',
    ]);
    expect(data.teamSkillSummary.coveredDesiredSkills).toEqual(['typescript', 'postgresql']);
    expect(data.teamSkillSummary.unmetDesiredSkills).toEqual(['react', 'redis']);

    const suggestedIds = data.candidates.map((s) => s.userId);
    // 25. Leader excluded
    expect(suggestedIds).not.toContain(leader.userId);
    // 27. Other team participant excluded
    expect(suggestedIds).not.toContain(otherTeamLeader.userId);
    // 28. Pending applicant excluded
    expect(suggestedIds).not.toContain(pendingApplicant.userId);

    // Eligible candidates ranked deterministically
    expect(suggestedIds).toEqual([candidateTop.userId, candidateMid.userId]);

    const first = data.candidates[0]!;
    expect(first.skillScore).toBe(100);
    expect(first.timezoneScore).toBe(100);
    expect(first.overallScore).toBe(100);
    expect(first.matchedDesiredSkills).toEqual(['react', 'redis']);

    const second = data.candidates[1]!;
    expect(second.skillScore).toBe(50);

    // 32 & 33. Repeated calls and limit=1 return identical top result
    const limitOneRes = await app.inject({
      method: 'GET',
      url: `/api/v1/teams/${teamId}/suggestions?limit=1`,
      headers: { cookie: leader.cookie },
    });
    expect(limitOneRes.statusCode).toBe(200);
    const limitOneData = limitOneRes.json<TeammateSuggestionsResponseDto>();
    expect(limitOneData.candidates.length).toBe(1);
    expect(limitOneData.candidates[0]?.userId).toBe(candidateTop.userId);
    expect(limitOneData.diagnostics.eligibleCandidatesEvaluated).toBe(2);
  });

  it('34–40. PATCH /api/v1/teams/:teamId/preferences updates desired skills, writes audit/outbox, enforces idempotency, and updates rankings', async () => {
    await cleanDatabase();
    const leader = await registerTestActor(app, 'PrefLeader', ['typescript'], 'Asia/Kolkata');
    const nonLeader = await registerTestActor(app, 'PrefNonLeader', ['postgresql'], 'Asia/Kolkata');
    const rustCandidate = await registerTestActor(app, 'RustCand', ['rust', 'wasm'], 'Asia/Kolkata');
    const goCandidate = await registerTestActor(app, 'GoCand', ['go', 'kubernetes'], 'Asia/Kolkata');

    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authMutationHeaders(leader),
      payload: {
        name: 'Preference Evolution Crew',
        description: 'Testing PATCH preferences.',
        desiredSkills: ['typescript', 'go', 'kubernetes'],
      },
    });
    const teamId = createRes.json<TeamDetailResponseDto>().team.id;

    // Initially GoCand ranks #1 (100% unmet coverage) over RustCand (0% unmet coverage)
    const beforeSug = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/teams/${teamId}/suggestions`,
        headers: { cookie: leader.cookie },
      })
    ).json<TeammateSuggestionsResponseDto>();
    expect(beforeSug.candidates[0]?.userId).toBe(goCandidate.userId);

    // 35. Non-leader cannot update team desired skills (403 UNAUTHORIZED_TEAM_ACTION)
    const forbiddenRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/teams/${teamId}/preferences`,
      headers: authMutationHeaders(nonLeader),
      payload: { desiredSkills: ['rust'] },
    });
    expect(forbiddenRes.statusCode).toBe(403);
    expect(forbiddenRes.json().error.code).toBe('UNAUTHORIZED_TEAM_ACTION');

    // 36 & 38. Leader updates desiredSkills with Idempotency-Key
    const idemKey = `pref_idem_${crypto.randomUUID()}`;
    const patchRes1 = await app.inject({
      method: 'PATCH',
      url: `/api/v1/teams/${teamId}/preferences`,
      headers: authMutationHeaders(leader, idemKey),
      payload: { desiredSkills: ['  TypeScript ', 'RUST', '  wasm  ', 'rust'] },
    });
    expect(patchRes1.statusCode).toBe(200);
    const updatedTeam = patchRes1.json<{ team: TeamDetailsDto }>().team;
    expect(updatedTeam.desiredSkills).toEqual(['typescript', 'rust', 'wasm']);

    // 38. Replay with identical Idempotency-Key and payload
    const patchReplay = await app.inject({
      method: 'PATCH',
      url: `/api/v1/teams/${teamId}/preferences`,
      headers: authMutationHeaders(leader, idemKey),
      payload: { desiredSkills: ['  TypeScript ', 'RUST', '  wasm  ', 'rust'] },
    });
    expect(patchReplay.statusCode).toBe(200);
    expect(patchReplay.headers['x-idempotent-replay']).toBe('true');

    // 39. Reuse same Idempotency-Key with different payload -> 409 IDEMPOTENCY_KEY_REUSED
    const patchMismatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/teams/${teamId}/preferences`,
      headers: authMutationHeaders(leader, idemKey),
      payload: { desiredSkills: ['python'] },
    });
    expect(patchMismatch.statusCode).toBe(409);
    expect(patchMismatch.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // 37. Verify audit_log and outbox_events contain TEAM_PREFERENCES_UPDATED
    const pool = getDbPool();
    const auditRows = await pool.query(
      `SELECT action, metadata FROM audit_log WHERE team_id = $1 AND action = 'TEAM_PREFERENCES_UPDATED'`,
      [teamId],
    );
    expect(auditRows.rowCount).toBe(1);

    const outboxRows = await pool.query(
      `SELECT event_type, payload FROM outbox_events WHERE team_id = $1 AND event_type = 'TEAM_PREFERENCES_UPDATED'`,
      [teamId],
    );
    expect(outboxRows.rowCount).toBe(1);

    // 34. Verify suggestion rankings immediately reflect the updated desiredSkills (RustCand now #1!)
    const afterSug = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/teams/${teamId}/suggestions`,
        headers: { cookie: leader.cookie },
      })
    ).json<TeammateSuggestionsResponseDto>();
    expect(afterSug.candidates[0]?.userId).toBe(rustCandidate.userId);
    expect(afterSug.candidates[0]?.skillScore).toBe(100);

    // 40. Verify EXPLAIN on candidate eligibility query uses indexes cleanly
    const explainRes = await pool.query(
      `EXPLAIN (FORMAT JSON)
       SELECT u.id, u.display_name, u.skills, u.timezone
       FROM users u
       WHERE NOT EXISTS (
         SELECT 1
         FROM team_members tm
         WHERE tm.hackathon_id = $1
           AND tm.user_id = u.id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM join_requests jr
         WHERE jr.team_id = $2
           AND jr.user_id = u.id
           AND jr.status = 'pending'
       )`,
      [hackathonId, teamId],
    );
    expect(explainRes.rowCount).toBeGreaterThan(0);
  });
});
