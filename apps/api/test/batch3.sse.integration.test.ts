import crypto from 'node:crypto';
import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  JoinRequestDto,
  PublicBoardSseEventPayload,
  TeamDetailsDto,
  TeamStreamSseEventPayload,
} from '@crewmesh/shared';
import { buildApp } from '../src/app.js';
import { resetEnvCache } from '../src/config/env.js';
import { runMigrationsUp } from '../src/db/migrate.js';
import { closeDbPool, getDbPool } from '../src/db/pool.js';
import { seedHackathon } from '../src/db/seed.js';

const TEST_ORIGIN = 'http://localhost:5173';

interface SseTestActor {
  userId: string;
  email: string;
  cookie: string;
  csrfToken: string;
}

interface ParsedSseFrame<T = Record<string, unknown>> {
  id: string;
  event: string;
  data: T;
}

class LiveSseTestClient<T = Record<string, unknown>> {
  public readonly frames: ParsedSseFrame<T>[] = [];
  private req: http.ClientRequest | null = null;
  private buffer = '';

  public async connect(params: {
    baseUrl: string;
    path: string;
    cookie?: string;
    lastEventId?: string;
  }): Promise<number> {
    return new Promise((resolve, reject) => {
      const url = new URL(params.path, params.baseUrl);
      const headers: Record<string, string> = {
        Accept: 'text/event-stream',
      };
      if (params.cookie) {
        headers.Cookie = params.cookie;
      }
      if (params.lastEventId) {
        headers['Last-Event-ID'] = params.lastEventId;
      }

      const req = http.request(url, { method: 'GET', headers }, (res) => {
        const statusCode = res.statusCode ?? 0;
        if (statusCode !== 200) {
          res.resume();
          resolve(statusCode);
          return;
        }

        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          this.buffer += chunk;
          this.parseFrames();
        });

        resolve(statusCode);
      });

      req.on('error', (err) => {
        reject(err);
      });
      req.end();
      this.req = req;
    });
  }

  private parseFrames(): void {
    let idx = this.buffer.indexOf('\n\n');
    while (idx !== -1) {
      const rawBlock = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      idx = this.buffer.indexOf('\n\n');

      const lines = rawBlock.split('\n');
      let id = '';
      let event = 'message';
      let dataStr = '';

      for (const line of lines) {
        if (line.startsWith(':')) {
          continue;
        }
        if (line.startsWith('id:')) {
          id = line.slice(3).trim();
        } else if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataStr += line.slice(5).trim();
        }
      }

      if (id && dataStr) {
        try {
          const parsed = JSON.parse(dataStr) as T;
          this.frames.push({ id, event, data: parsed });
        } catch {
          // Ignore non-JSON frame
        }
      }
    }
  }

  public async waitForEvent(
    predicate: (frame: ParsedSseFrame<T>) => boolean,
    timeoutMs = 4_000,
  ): Promise<ParsedSseFrame<T>> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const match = this.frames.find(predicate);
      if (match) {
        return match;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(
      `Timed out waiting for SSE event after ${timeoutMs}ms. Received frames: ${JSON.stringify(this.frames)}`,
    );
  }

  public close(): void {
    if (this.req) {
      this.req.destroy();
      this.req = null;
    }
  }
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

async function registerSseActor(app: FastifyInstance, label: string): Promise<SseTestActor> {
  const email = `sse_${label.toLowerCase()}_${crypto.randomUUID().slice(0, 8)}@example.com`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { origin: TEST_ORIGIN },
    payload: {
      email,
      password: 'SseTestPassword!2026',
      displayName: `SSE ${label}`,
      skills: ['typescript', 'postgresql'],
      timezone: 'UTC',
    },
  });

  const token = extractCookieValue(res.headers['set-cookie'], 'crewmesh_session');
  const body = res.json<{ user: { id: string; email: string }; csrfToken: string }>();

  return {
    userId: body.user.id,
    email: body.user.email,
    cookie: `crewmesh_session=${encodeURIComponent(token!)}`,
    csrfToken: body.csrfToken,
  };
}

function authHeaders(actor: SseTestActor): Record<string, string> {
  return {
    origin: TEST_ORIGIN,
    cookie: actor.cookie,
    'x-csrf-token': actor.csrfToken,
    'idempotency-key': `idem_sse_${crypto.randomUUID()}`,
  };
}

describe('Batch 3 — Durable Outbox & Real-Time HTTP SSE Integration Suite (PostgreSQL)', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let hackathonId: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.APP_ORIGIN = TEST_ORIGIN;
    process.env.CSRF_SECRET = 'batch3_sse_test_csrf_secret_with_at_least_32_bytes_entropy';
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
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = address;
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

  it('Scenarios 1–9: Public board SSE, leader join-request SSE, regular member role filtering, and unauthorized stream rejection', async () => {
    const leader = await registerSseActor(app, 'Leader');
    const member = await registerSseActor(app, 'Member');
    const applicant = await registerSseActor(app, 'Applicant');
    const outsider = await registerSseActor(app, 'Outsider');

    // 1. Open public board SSE stream
    const boardStream = new LiveSseTestClient<PublicBoardSseEventPayload>();
    const boardStatus = await boardStream.connect({
      baseUrl,
      path: `/api/v1/hackathons/${hackathonId}/events`,
    });
    expect(boardStatus).toBe(200);

    try {
      // 2. Create team through the API
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/v1/hackathons/${hackathonId}/teams`,
        headers: authHeaders(leader),
        payload: { name: 'Live Stream Crew', minTeamSize: 2, maxTeamSize: 4 },
      });
      expect(createRes.statusCode).toBe(201);
      const teamId = createRes.json<{ team: TeamDetailsDto }>().team.id;

      // 3. Connected board stream receives TEAM_CREATED notification
      const createdFrame = await boardStream.waitForEvent((f) => f.event === 'TEAM_CREATED');
      expect(createdFrame.data.teamId).toBe(teamId);
      expect(createdFrame.data.status).toBe('forming');
      expect(createdFrame.data.memberCount).toBe(1);

      // 9. Unauthorized user (outsider not in team) is rejected with 403 on private team stream
      const outsiderStream = new LiveSseTestClient();
      const outsiderStatus = await outsiderStream.connect({
        baseUrl,
        path: `/api/v1/teams/${teamId}/events`,
        cookie: outsider.cookie,
      });
      expect(outsiderStatus).toBe(403);
      outsiderStream.close();

      // Leader connects to private team SSE stream
      const leaderStream = new LiveSseTestClient<TeamStreamSseEventPayload>();
      expect(
        await leaderStream.connect({
          baseUrl,
          path: `/api/v1/teams/${teamId}/events`,
          cookie: leader.cookie,
        }),
      ).toBe(200);

      // First add `member` to the team so `member` can open a regular-member team SSE stream
      const memberJrId = (
        await app.inject({
          method: 'POST',
          url: `/api/v1/teams/${teamId}/join-requests`,
          headers: authHeaders(member),
        })
      ).json<{ joinRequest: JoinRequestDto }>().joinRequest.id;

      // 6. Leader receives JOIN_REQUEST_CREATED event
      const leaderJrFrame = await leaderStream.waitForEvent(
        (f) => f.event === 'JOIN_REQUEST_CREATED',
      );
      expect(leaderJrFrame.data.teamId).toBe(teamId);

      // 7. Public board stream NEVER receives private JOIN_REQUEST_CREATED
      expect(boardStream.frames.some((f) => f.event === 'JOIN_REQUEST_CREATED')).toBe(false);

      // 4 & 5. Leader accepts `member` -> board stream receives safe MEMBER_JOINED & JOIN_REQUEST_ACCEPTED updates
      await app.inject({
        method: 'POST',
        url: `/api/v1/teams/${teamId}/join-requests/${memberJrId}/accept`,
        headers: authHeaders(leader),
      });

      const boardJoinedFrame = await boardStream.waitForEvent(
        (f) => f.event === 'MEMBER_JOINED',
      );
      expect(boardJoinedFrame.data.memberCount).toBe(2);
      expect(boardJoinedFrame.data.status).toBe('ready');
      expect(JSON.stringify(boardJoinedFrame.data)).not.toContain(member.email);
      expect(JSON.stringify(boardJoinedFrame.data)).not.toContain('applicantUserId');

      // Regular member now connects to the private team SSE stream
      const memberStream = new LiveSseTestClient<TeamStreamSseEventPayload>();
      expect(
        await memberStream.connect({
          baseUrl,
          path: `/api/v1/teams/${teamId}/events`,
          cookie: member.cookie,
        }),
      ).toBe(200);

      // 8. Second applicant submits a join request -> Leader receives JOIN_REQUEST_CREATED,
      //    but regular `memberStream` does NOT receive leader-only JOIN_REQUEST_CREATED!
      await app.inject({
        method: 'POST',
        url: `/api/v1/teams/${teamId}/join-requests`,
        headers: authHeaders(applicant),
        payload: { message: 'Private message for leader inbox' },
      });

      await leaderStream.waitForEvent(
        (f) =>
          f.event === 'JOIN_REQUEST_CREATED' &&
          f.data.data.applicantUserId === applicant.userId,
      );

      // Give a brief window and assert regular member received zero JOIN_REQUEST_CREATED frames
      await new Promise((r) => setTimeout(r, 250));
      expect(memberStream.frames.some((f) => f.event === 'JOIN_REQUEST_CREATED')).toBe(false);

      memberStream.close();
      leaderStream.close();
    } finally {
      boardStream.close();
    }
  });

  it('Scenarios 10, 11, 12, 13, 14 & 15: Last-Event-ID ordered replay, deduplication, listener interruption recovery, and failed mutation rollback', async () => {
    const leader = await registerSseActor(app, 'ReplayLeader');
    const m1 = await registerSseActor(app, 'ReplayM1');
    const m2 = await registerSseActor(app, 'ReplayM2');

    const boardStream1 = new LiveSseTestClient<PublicBoardSseEventPayload>();
    await boardStream1.connect({
      baseUrl,
      path: `/api/v1/hackathons/${hackathonId}/events`,
    });

    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authHeaders(leader),
      payload: { name: 'Replay & Recovery Team', minTeamSize: 2, maxTeamSize: 3 },
    });
    const teamId = createRes.json<{ team: TeamDetailsDto }>().team.id;

    const firstBoardFrame = await boardStream1.waitForEvent((f) => f.event === 'TEAM_CREATED');
    const checkpointEventId = firstBoardFrame.id;

    // 10. Client disconnects before m1 joins
    boardStream1.close();

    // 14. Trigger a failed mutation (duplicate team name) and confirm NO outbox event is committed
    const pool = getDbPool();
    const outboxBeforeFail = await pool.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM outbox_events',
    );
    const failedCreate = await app.inject({
      method: 'POST',
      url: `/api/v1/hackathons/${hackathonId}/teams`,
      headers: authHeaders(m1),
      payload: { name: 'Replay & Recovery Team' },
    });
    expect(failedCreate.statusCode).toBe(409);

    const outboxAfterFail = await pool.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM outbox_events',
    );
    expect(outboxAfterFail.rows[0]?.cnt).toBe(outboxBeforeFail.rows[0]?.cnt);

    // While client is disconnected, m1 requests and is accepted
    const jr1Id = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/teams/${teamId}/join-requests`,
        headers: authHeaders(m1),
      })
    ).json<{ joinRequest: JoinRequestDto }>().joinRequest.id;

    await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${teamId}/join-requests/${jr1Id}/accept`,
      headers: authHeaders(leader),
    });

    // 10 & 11. Client reconnects with Last-Event-ID = checkpointEventId and receives missed events in order
    const boardStream2 = new LiveSseTestClient<PublicBoardSseEventPayload>();
    await boardStream2.connect({
      baseUrl,
      path: `/api/v1/hackathons/${hackathonId}/events`,
      lastEventId: checkpointEventId,
    });

    try {
      const replayedJoin = await boardStream2.waitForEvent(
        (f) => f.event === 'MEMBER_JOINED',
      );
      expect(BigInt(replayedJoin.id) > BigInt(checkpointEventId)).toBe(true);
      expect(replayedJoin.data.memberCount).toBe(2);

      // 13. Simulate a database listener interruption and perform another join
      await app.sseDispatcher.simulateListenerInterruptionForTest();

      const jr2Id = (
        await app.inject({
          method: 'POST',
          url: `/api/v1/teams/${teamId}/join-requests`,
          headers: authHeaders(m2),
        })
      ).json<{ joinRequest: JoinRequestDto }>().joinRequest.id;

      await app.inject({
        method: 'POST',
        url: `/api/v1/teams/${teamId}/join-requests/${jr2Id}/accept`,
        headers: authHeaders(leader),
      });

      const recoveredFrame = await boardStream2.waitForEvent(
        (f) => f.event === 'MEMBER_JOINED' && f.data.memberCount === 3,
      );
      expect(recoveredFrame.data.isFull).toBe(true);

      // 12. Verify strictly increasing event IDs with zero duplicates
      const ids = boardStream2.frames.map((f) => BigInt(f.id));
      for (let i = 1; i < ids.length; i += 1) {
        expect(ids[i]! > ids[i - 1]!).toBe(true);
      }
    } finally {
      boardStream2.close();
    }
  });
});
