import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { resetEnvCache } from '../src/config/env.js';
import { runMigrationsUp } from '../src/db/migrate.js';
import { closeDbPool, getDbPool, withTransaction } from '../src/db/pool.js';
import { seedHackathon } from '../src/db/seed.js';
import { sha256Hex } from '../src/security/crypto.js';

const TEST_ORIGIN = 'http://localhost:5173';

function extractCookieValue(setCookieHeader: string | string[] | undefined, cookieName: string): string | null {
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

describe('Phase 1 — Foundation, Database Invariants, and Auth Integration Suite (PostgreSQL)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.APP_ORIGIN = TEST_ORIGIN;
    process.env.CSRF_SECRET = 'test_csrf_secret_with_at_least_32_bytes_entropy_0123456789';
    process.env.DATABASE_URL =
      process.env.TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://crewmesh:crewmesh_local_dev_password@localhost:5432/crewmesh_test';
    resetEnvCache();

    await runMigrationsUp();
    await seedHackathon();
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
    await seedHackathon(pool);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    await closeDbPool();
  });

  it('1. GET /health returns 200 ok and security headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-request-id']).toBeTruthy();

    const body = res.json<{ status: string; service: string }>();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('crewmesh-api');
  });

  it('2. GET /ready verifies live PostgreSQL connectivity and returns server timestamp', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/ready',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; database: string; latencyMs: number; serverTimeIso: string }>();
    expect(body.status).toBe('ready');
    expect(body.database).toBe('connected');
    expect(typeof body.latencyMs).toBe('number');
    expect(Date.parse(body.serverTimeIso)).not.toBeNaN();
  });

  it('3. Migrations and Hack4Hack 2026 seed are idempotent and queryable via GET /api/v1/hackathons/current', async () => {
    // Re-running migrations and seed must be a no-op / idempotent update
    const secondRunApplied = await runMigrationsUp();
    expect(secondRunApplied).toEqual([]);

    const seededAgain = await seedHackathon();
    expect(seededAgain.slug).toBe('hack4hack-crew-2026');
    expect(seededAgain.minTeamSize).toBe(2);
    expect(seededAgain.maxTeamSize).toBe(5);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/hackathons/current',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ hackathon: { slug: string; minTeamSize: number; maxTeamSize: number } }>();
    expect(body.hackathon.slug).toBe('hack4hack-crew-2026');
    expect(body.hackathon.minTeamSize).toBe(2);
    expect(body.hackathon.maxTeamSize).toBe(5);
  });

  it('4. POST /api/v1/auth/register creates a user, normalizes email & skills, hashes password with Argon2id, and stores only hashed session/CSRF tokens', async () => {
    const plainPassword = 'CorrectHorseBatteryStaple!2026';
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: {
        origin: TEST_ORIGIN,
      },
      payload: {
        email: '  Alice.Dev@Example.COM  ',
        password: plainPassword,
        displayName: 'Alice Developer',
        skills: ['TypeScript', 'PostgreSQL', 'typescript', 'React JS'],
        timezone: 'Asia/Kolkata',
        bio: 'Systems engineer interested in distributed locking.',
      },
    });

    expect(res.statusCode).toBe(201);
    const rawBody = res.body;
    expect(rawBody).not.toContain(plainPassword);
    expect(rawBody).not.toContain('$argon2id$');

    const body = res.json<{
      user: { id: string; email: string; displayName: string; skills: string[]; timezone: string };
      csrfToken: string;
    }>();
    expect(body.user.email).toBe('alice.dev@example.com');
    expect(body.user.displayName).toBe('Alice Developer');
    expect(body.user.skills).toEqual(['typescript', 'postgresql', 'react-js']);
    expect(body.user.timezone).toBe('Asia/Kolkata');
    expect(body.csrfToken.length).toBeGreaterThanOrEqual(32);

    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie);
    expect(cookieStr).toContain('HttpOnly');
    expect(cookieStr).toContain('SameSite=Lax');

    const rawSessionToken = extractCookieValue(setCookie, 'crewmesh_session');
    expect(rawSessionToken).toBeTruthy();

    // Verify database row stores Argon2id hash and SHA-256 session/CSRF token hashes, never plaintext
    const pool = getDbPool();
    const dbUser = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [body.user.id],
    );
    expect(dbUser.rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
    expect(dbUser.rows[0]?.password_hash).not.toBe(plainPassword);

    const dbSession = await pool.query<{ token_hash: string; csrf_token_hash: string }>(
      'SELECT token_hash, csrf_token_hash FROM sessions WHERE user_id = $1',
      [body.user.id],
    );
    expect(dbSession.rows[0]?.token_hash).toBe(sha256Hex(rawSessionToken!));
    expect(dbSession.rows[0]?.csrf_token_hash).toBe(sha256Hex(body.csrfToken));
  });

  it('5. POST /api/v1/auth/register rejects duplicate normalized email with 409 EMAIL_ALREADY_REGISTERED', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { origin: TEST_ORIGIN },
      payload: {
        email: 'participant@example.com',
        password: 'StrongPassword#1234',
        displayName: 'First User',
      },
    });
    expect(first.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { origin: TEST_ORIGIN },
      payload: {
        email: '  PARTICIPANT@EXAMPLE.COM ',
        password: 'AnotherPassword#5678',
        displayName: 'Duplicate User',
      },
    });

    expect(duplicate.statusCode).toBe(409);
    const errBody = duplicate.json<{ error: { code: string } }>();
    expect(errBody.error.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('6. POST /api/v1/auth/login succeeds with valid credentials and rotates existing session token', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { origin: TEST_ORIGIN },
      payload: {
        email: 'bob@example.com',
        password: 'BobSecurePassword!99',
        displayName: 'Bob Builder',
      },
    });
    const initialToken = extractCookieValue(reg.headers['set-cookie'], 'crewmesh_session')!;
    const initialCsrf = reg.json<AuthSessionResponse>().csrfToken;

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: {
        origin: TEST_ORIGIN,
        cookie: `crewmesh_session=${encodeURIComponent(initialToken)}`,
        'x-csrf-token': initialCsrf,
      },
      payload: {
        email: '  BOB@example.com ',
        password: 'BobSecurePassword!99',
      },
    });

    expect(loginRes.statusCode).toBe(200);
    const rotatedToken = extractCookieValue(loginRes.headers['set-cookie'], 'crewmesh_session')!;
    expect(rotatedToken).toBeTruthy();
    expect(rotatedToken).not.toBe(initialToken);

    // Old session token must now be revoked in PostgreSQL
    const oldMeRes = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: {
        cookie: `crewmesh_session=${encodeURIComponent(initialToken)}`,
      },
    });
    expect(oldMeRes.statusCode).toBe(401);

    // New rotated session token must work
    const newMeRes = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: {
        cookie: `crewmesh_session=${encodeURIComponent(rotatedToken)}`,
      },
    });
    expect(newMeRes.statusCode).toBe(200);
  });

  it('7. POST /api/v1/auth/login rejects wrong password and non-existent email with identical generic 401 INVALID_CREDENTIALS', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { origin: TEST_ORIGIN },
      payload: {
        email: 'carol@example.com',
        password: 'CarolValidPassword!11',
        displayName: 'Carol',
      },
    });

    const wrongPass = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: TEST_ORIGIN },
      payload: {
        email: 'carol@example.com',
        password: 'WrongPassword!00',
      },
    });

    const unknownUser = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: TEST_ORIGIN },
      payload: {
        email: 'nobody@example.com',
        password: 'WrongPassword!00',
      },
    });

    expect(wrongPass.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);

    const wpBody = wrongPass.json<{ error: { code: string; message: string } }>();
    const uuBody = unknownUser.json<{ error: { code: string; message: string } }>();
    expect(wpBody.error.code).toBe('INVALID_CREDENTIALS');
    expect(uuBody.error.code).toBe('INVALID_CREDENTIALS');
    expect(wpBody.error.message).toBe(uuBody.error.message);
  });

  it('8. GET /api/v1/auth/me returns authenticated user profile and CSRF token; unauthenticated request returns 401', async () => {
    const unauth = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
    });
    expect(unauth.statusCode).toBe(401);
    expect(unauth.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');

    const reg = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { origin: TEST_ORIGIN },
      payload: {
        email: 'dave@example.com',
        password: 'DavePassword!2026',
        displayName: 'Dave Ops',
        timezone: 'UTC',
      },
    });
    const sessionToken = extractCookieValue(reg.headers['set-cookie'], 'crewmesh_session')!;

    const meRes = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: {
        cookie: `crewmesh_session=${encodeURIComponent(sessionToken)}`,
      },
    });
    expect(meRes.statusCode).toBe(200);
    const meBody = meRes.json<{ user: { email: string; displayName: string }; csrfToken: string }>();
    expect(meBody.user.email).toBe('dave@example.com');
    expect(meBody.user.displayName).toBe('Dave Ops');
    expect(meBody.csrfToken).toBeTruthy();
  });

  it('9. CSRF and Same-Origin protection rejects cross-origin or missing/invalid X-CSRF-Token on state-changing routes', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { origin: TEST_ORIGIN },
      payload: {
        email: 'erin@example.com',
        password: 'ErinPassword!2026',
        displayName: 'Erin Sec',
      },
    });
    const sessionToken = extractCookieValue(reg.headers['set-cookie'], 'crewmesh_session')!;
    const { csrfToken } = reg.json<{ csrfToken: string }>();

    // Cross-origin request must fail with 403 ORIGIN_INVALID
    const evilOriginRes = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/profile',
      headers: {
        origin: 'https://evil-attacker.example.org',
        cookie: `crewmesh_session=${encodeURIComponent(sessionToken)}`,
        'x-csrf-token': csrfToken,
      },
      payload: { displayName: 'Pwned Name' },
    });
    expect(evilOriginRes.statusCode).toBe(403);
    expect(evilOriginRes.json<{ error: { code: string } }>().error.code).toBe('ORIGIN_INVALID');

    // Missing CSRF token must fail with 403 CSRF_INVALID
    const missingCsrfRes = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/profile',
      headers: {
        origin: TEST_ORIGIN,
        cookie: `crewmesh_session=${encodeURIComponent(sessionToken)}`,
      },
      payload: { displayName: 'Missing CSRF' },
    });
    expect(missingCsrfRes.statusCode).toBe(403);
    expect(missingCsrfRes.json<{ error: { code: string } }>().error.code).toBe('CSRF_INVALID');

    // Valid Origin + Valid X-CSRF-Token succeeds
    const validUpdateRes = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/profile',
      headers: {
        origin: TEST_ORIGIN,
        cookie: `crewmesh_session=${encodeURIComponent(sessionToken)}`,
        'x-csrf-token': csrfToken,
      },
      payload: {
        displayName: 'Erin Security Verified',
        skills: ['Rust', 'PostgreSQL'],
        timezone: 'Asia/Kolkata',
      },
    });
    expect(validUpdateRes.statusCode).toBe(200);
    expect(validUpdateRes.json<{ user: { displayName: string } }>().user.displayName).toBe(
      'Erin Security Verified',
    );
  });

  it('10. POST /api/v1/auth/logout revokes session in PostgreSQL and invalidates subsequent requests', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { origin: TEST_ORIGIN },
      payload: {
        email: 'frank@example.com',
        password: 'FrankPassword!2026',
        displayName: 'Frank',
      },
    });
    const sessionToken = extractCookieValue(reg.headers['set-cookie'], 'crewmesh_session')!;
    const { csrfToken } = reg.json<{ csrfToken: string }>();

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        origin: TEST_ORIGIN,
        cookie: `crewmesh_session=${encodeURIComponent(sessionToken)}`,
        'x-csrf-token': csrfToken,
      },
    });
    expect(logoutRes.statusCode).toBe(200);
    expect(logoutRes.json<{ loggedOut: boolean }>().loggedOut).toBe(true);

    // Subsequent call with the revoked session cookie must return 401
    const afterLogoutMe = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: {
        cookie: `crewmesh_session=${encodeURIComponent(sessionToken)}`,
      },
    });
    expect(afterLogoutMe.statusCode).toBe(401);
  });

  it('11. Database invariants enforce forming/ready status, one-team-per-user, one-pending-request, and durable audit preservation across team deletion', async () => {
    const pool = getDbPool();
    const hackathonRes = await pool.query<{ id: string }>(
      "SELECT id FROM hackathons WHERE slug = 'hack4hack-crew-2026' LIMIT 1",
    );
    const hackathonId = hackathonRes.rows[0]!.id;

    // Create two test users
    const u1Res = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ('u1@example.com', '$argon2id$v=19$m=65536,t=3,p=4$abcdefghijklmnop$1234567890abcdefghijklmnop', 'User One')
       RETURNING id`,
    );
    const u2Res = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ('u2@example.com', '$argon2id$v=19$m=65536,t=3,p=4$abcdefghijklmnop$1234567890abcdefghijklmnop', 'User Two')
       RETURNING id`,
    );
    const u1Id = u1Res.rows[0]!.id;
    const u2Id = u2Res.rows[0]!.id;

    // 11a. Creating a 1-member team with status = 'ready' when min_team_size = 2 must fail DB CHECK constraint
    await expect(
      pool.query(
        `INSERT INTO teams (hackathon_id, name, leader_user_id, status, member_count, min_team_size, max_team_size)
         VALUES ($1, 'Invalid Ready Team', $2, 'ready', 1, 2, 5)`,
        [hackathonId, u1Id],
      ),
    ).rejects.toThrow();

    await pool.query(
      `INSERT INTO hackathon_participants (hackathon_id, user_id, status) VALUES ($1, $2, 'registered'), ($1, $3, 'registered') ON CONFLICT (hackathon_id, user_id) DO NOTHING`,
      [hackathonId, u1Id, u2Id],
    );

    const { team1Id, team2Id } = await withTransaction(async (client) => {
      const t1 = await client.query<{ id: string }>(`INSERT INTO teams (hackathon_id, name, leader_user_id, status, member_count, min_team_size, max_team_size) VALUES ($1, 'Team Alpha', $2, 'forming', 1, 2, 5) RETURNING id`, [hackathonId, u1Id]);
      const t2 = await client.query<{ id: string }>(`INSERT INTO teams (hackathon_id, name, leader_user_id, status, member_count, min_team_size, max_team_size) VALUES ($1, 'Team Beta', $2, 'forming', 1, 2, 5) RETURNING id`, [hackathonId, u2Id]);
      const id1 = t1.rows[0]!.id, id2 = t2.rows[0]!.id;
      await client.query(`INSERT INTO team_members (team_id, hackathon_id, user_id, role) VALUES ($1, $3, $4, 'leader'), ($2, $3, $5, 'leader')`, [id1, id2, hackathonId, u1Id, u2Id]);
      return { team1Id: id1, team2Id: id2 };
    }, pool);

    // 11c. User 1 cannot join Team Beta in the same hackathon (unique hackathon_id, user_id)
    await expect(
      pool.query(
        `INSERT INTO team_members (team_id, hackathon_id, user_id, role) VALUES ($1, $2, $3, 'member')`,
        [team2Id, hackathonId, u1Id],
      ),
    ).rejects.toThrow();

    // 11d. Duplicate pending join request for same (team_id, user_id) is rejected by partial unique index
    await pool.query(
      `INSERT INTO join_requests (team_id, hackathon_id, user_id, status) VALUES ($1, $2, $3, 'pending')`,
      [team1Id, hackathonId, u2Id],
    );
    await expect(
      pool.query(
        `INSERT INTO join_requests (team_id, hackathon_id, user_id, status) VALUES ($1, $2, $3, 'pending')`,
        [team1Id, hackathonId, u2Id],
      ),
    ).rejects.toThrow();

    // 11e. Audit log record preserves team_id after the team is deleted
    await pool.query(
      `INSERT INTO audit_log (hackathon_id, team_id, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, $3, 'TEAM_CREATED', 'team', $4, '{"name":"Team Alpha"}'::jsonb)`,
      [hackathonId, team1Id, u1Id, String(team1Id)],
    );

    await pool.query('DELETE FROM teams WHERE id = $1', [team1Id]);

    const auditRes = await pool.query<{ team_id: string; action: string }>(
      'SELECT team_id, action FROM audit_log WHERE team_id = $1',
      [team1Id],
    );
    expect(auditRes.rows.length).toBe(1);
    expect(auditRes.rows[0]?.team_id).toBe(team1Id);
    expect(auditRes.rows[0]?.action).toBe('TEAM_CREATED');
  });
});
