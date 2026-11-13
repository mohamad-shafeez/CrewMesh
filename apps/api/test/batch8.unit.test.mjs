import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadTsModule } from '../../../scripts/ts-loader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sharedMod = loadTsModule(path.resolve(__dirname, '../../../packages/shared/src/index.ts'));
const auditOutboxMod = loadTsModule(
  path.resolve(__dirname, '../src/services/audit-outbox-service.ts'),
  {
    '@crewmesh/shared': sharedMod,
  },
);
const sseDispatcherMod = loadTsModule(
  path.resolve(__dirname, '../src/services/sse-dispatcher.ts'),
  {
    pg: { Client: class MockPgClient {} },
    '@crewmesh/shared': sharedMod,
    '../config/env.js': {
      getEnv: () => ({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://localhost:5432/crewmesh_test',
        TEST_DATABASE_URL: 'postgresql://localhost:5432/crewmesh_test',
      }),
    },
    '../db/pool.js': { getDbPool: () => ({}) },
    '../plugins/error-handler.js': {
      AppError: class AppError extends Error {
        constructor(statusCode, code, message) {
          super(message);
          this.statusCode = statusCode;
          this.code = code;
        }
      },
    },
    './audit-outbox-service.js': auditOutboxMod,
  },
);

const { sanitizeEventMetadata, isSensitiveMetadataKey } = auditOutboxMod;
const { OutboxSseDispatcher, projectTeamStreamSseEvent } = sseDispatcherMod;

test('1. sanitizeEventMetadata recursively strips sensitive keys across nested objects, arrays of objects, nested arrays, and mixed/snake case keys', () => {
  assert.equal(isSensitiveMetadataKey('Password_Hash'), true);
  assert.equal(isSensitiveMetadataKey('SESSION-TOKEN'), true);
  assert.equal(isSensitiveMetadataKey('X_CSRF_TOKEN'), true);
  assert.equal(isSensitiveMetadataKey('applicant_email'), true);
  assert.equal(isSensitiveMetadataKey('raw_invite_code'), true);
  assert.equal(isSensitiveMetadataKey('tokenPrefix'), false);
  assert.equal(isSensitiveMetadataKey('memberCount'), false);

  const dirty = {
    teamId: 'team-1',
    tokenPrefix: 'ab12cd34',
    PasswordHash: '$argon2id$secret',
    applicant_email: 'private@example.com',
    nestedProfile: {
      displayName: 'Aarav',
      EmailAddress: 'aarav@example.com',
      session_token: 'tok_123',
      skills: ['typescript', 'rust'],
    },
    membersArray: [
      {
        userId: 'u1',
        displayName: 'Member 1',
        user_email: 'm1@example.com',
        csrf_Token: 'csrf_secret',
        deepMatrix: [
          [
            {
              safeLabel: 'ok',
              rawInviteCode: 'secret_invite_code_value',
              private_key: 'pem_key',
            },
          ],
        ],
      },
    ],
  };

  const sanitized = sanitizeEventMetadata(dirty);
  assert.deepEqual(sanitized, {
    teamId: 'team-1',
    tokenPrefix: 'ab12cd34',
    nestedProfile: {
      displayName: 'Aarav',
      skills: ['typescript', 'rust'],
    },
    membersArray: [
      {
        userId: 'u1',
        displayName: 'Member 1',
        deepMatrix: [
          [
            {
              safeLabel: 'ok',
            },
          ],
        ],
      },
    ],
  });
});

test('2. projectTeamStreamSseEvent enforces explicit allowlist projection per event_type and strips arbitrary unexpected fields', () => {
  const projected = projectTeamStreamSseEvent(
    {
      id: '42',
      hackathon_id: 'h1',
      team_id: 't1',
      scope: 'team',
      event_type: 'JOIN_REQUEST_CREATED',
      payload: {
        joinRequestId: 'jr1',
        teamId: 't1',
        hackathonId: 'h1',
        applicantUserId: 'u9',
        source: 'board',
        status: 'pending',
        unexpectedInternalField: 'should-not-be-projected',
        applicantMessageSecret: 'should-not-be-projected',
        applicantEmail: 'hidden@example.com',
      },
      created_at: new Date('2026-11-13T00:00:00.000Z'),
    },
    'leader',
  );

  assert.deepEqual(projected.data, {
    joinRequestId: 'jr1',
    teamId: 't1',
    hackathonId: 'h1',
    applicantUserId: 'u9',
    source: 'board',
    status: 'pending',
  });

  // Regular member must not receive JOIN_REQUEST_CREATED
  const memberProjected = projectTeamStreamSseEvent(
    {
      id: '42',
      hackathon_id: 'h1',
      team_id: 't1',
      scope: 'team',
      event_type: 'JOIN_REQUEST_CREATED',
      payload: { joinRequestId: 'jr1' },
      created_at: new Date('2026-11-13T00:00:00.000Z'),
    },
    'member',
  );
  assert.equal(memberProjected, null);
});

test('3. OutboxSseDispatcher cursor-paginates >500 missed events (620 events across 3 pages) and filters leader-only events in SQL for regular members', async () => {
  const totalEvents = 620;
  const allBoardRows = Array.from({ length: totalEvents }, (_, i) => ({
    id: String(i + 1),
    hackathon_id: 'h1',
    team_id: 't1',
    scope: 'both',
    event_type: 'TEAM_UPDATED',
    payload: {
      teamId: 't1',
      hackathonId: 'h1',
      status: 'ready',
      memberCount: 2,
      minTeamSize: 2,
      maxTeamSize: 5,
      isFull: false,
    },
    created_at: new Date('2026-11-13T00:00:00.000Z'),
  }));

  let pageQueriesExecuted = 0;
  const mockPool = {
    async query(sql, params) {
      if (sql.includes('SELECT MAX(id)')) {
        return { rows: [{ max_id: String(totalEvents) }] };
      }
      if (sql.includes('FROM outbox_events') && sql.includes('id > $2::bigint')) {
        pageQueriesExecuted += 1;
        const sinceId = Number(params[1]);
        const upToId = Number(params[2]);
        const limit = Number(params[3]);
        const slice = allBoardRows
          .filter((r) => Number(r.id) > sinceId && Number(r.id) <= upToId)
          .slice(0, limit);
        return { rows: slice };
      }
      return { rows: [] };
    },
  };

  const dispatcher = new OutboxSseDispatcher(mockPool);
  dispatcher.started = true;
  dispatcher.lastDispatchedId = BigInt(totalEvents);

  const writtenFrames = [];
  const mockRes = {
    writableEnded: false,
    destroyed: false,
    on() {},
    once() {},
    write(chunk) {
      writtenFrames.push(chunk);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  };

  const subscriber = {
    id: 'sub_board_620',
    kind: 'board',
    hackathonId: 'h1',
    res: mockRes,
    lastSentEventId: 0n,
    closed: false,
    queuedFrames: 0,
  };

  await dispatcher.registerSubscriber(subscriber, 0n);

  // 620 events across 250-row batches = 3 queries (250 + 250 + 120 = 620)
  assert.equal(pageQueriesExecuted, 3);
  assert.equal(writtenFrames.length, 620);
  assert.equal(subscriber.lastSentEventId, 620n);
});

test('4. OutboxSseDispatcher isolates per-subscriber transient DB errors and recovers missed events on the next drain cycle', async () => {
  let failAuthOnceForSub1 = true;
  const eventsInDb = [
    {
      id: '10',
      hackathon_id: 'h1',
      team_id: 't1',
      scope: 'team',
      event_type: 'MEMBER_JOINED',
      payload: {
        teamId: 't1',
        hackathonId: 'h1',
        userId: 'u2',
        memberCount: 2,
        minTeamSize: 2,
        maxTeamSize: 5,
        status: 'ready',
        isFull: false,
      },
      created_at: new Date('2026-11-13T00:00:00.000Z'),
    },
  ];

  const mockPool = {
    async query(sql, params) {
      if (sql.includes('SELECT MAX(id)')) {
        return { rows: [{ max_id: '9' }] };
      }
      if (sql.includes('FROM sessions')) {
        if (params[0] === 'sess_sub1' && failAuthOnceForSub1) {
          failAuthOnceForSub1 = false;
          throw new Error('Simulated transient PostgreSQL connection timeout');
        }
        return { rows: [{ id: params[0] }] };
      }
      if (sql.includes('FROM team_members')) {
        return { rows: [{ role: 'leader' }] };
      }
      if (sql.includes('FROM outbox_events') && sql.includes('WHERE id > $1::bigint')) {
        const since = Number(params[0]);
        return { rows: eventsInDb.filter((e) => Number(e.id) > since) };
      }
      if (sql.includes('FROM outbox_events') && sql.includes('id > $2::bigint')) {
        const since = Number(params[1]);
        const upTo = Number(params[2]);
        return {
          rows: eventsInDb.filter((e) => Number(e.id) > since && Number(e.id) <= upTo),
        };
      }
      return { rows: [] };
    },
  };

  const dispatcher = new OutboxSseDispatcher(mockPool);
  dispatcher.started = true;
  dispatcher.lastDispatchedId = 9n;

  const sub1Frames = [];
  const sub2Frames = [];

  const makeMockRes = (arr) => ({
    writableEnded: false,
    destroyed: false,
    on() {},
    once() {},
    write(chunk) {
      arr.push(chunk);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  });

  const sub1 = {
    id: 'team_sub_1',
    kind: 'team',
    teamId: 't1',
    hackathonId: 'h1',
    userId: 'u1',
    sessionId: 'sess_sub1',
    res: makeMockRes(sub1Frames),
    lastSentEventId: 9n,
    closed: false,
    queuedFrames: 0,
  };

  const sub2 = {
    id: 'team_sub_2',
    kind: 'team',
    teamId: 't1',
    hackathonId: 'h1',
    userId: 'u2',
    sessionId: 'sess_sub2',
    res: makeMockRes(sub2Frames),
    lastSentEventId: 9n,
    closed: false,
    queuedFrames: 0,
  };

  dispatcher.subscribers.set(sub1.id, sub1);
  dispatcher.subscribers.set(sub2.id, sub2);

  // First drain: sub1 hits transient error, sub2 succeeds immediately!
  await dispatcher.requestDrain();
  assert.equal(sub2Frames.length, 1);
  assert.equal(sub1Frames.length, 0);
  assert.equal(sub1.needsCatchup, true);
  assert.equal(sub1.lastSentEventId, 9n);

  // Second drain: sub1 automatically catches up event 10 from its preserved lastSentEventId (9n)!
  await dispatcher.requestDrain();
  assert.equal(sub1Frames.length, 1);
  assert.equal(sub1.needsCatchup, false);
  assert.equal(sub1.lastSentEventId, 10n);
});

test('5. Migration 007 rejects caller-supplied explicit outbox_events.id values, auth.ts enforces auth_email rate limiting, and board.k6.js reads scenario-tagged metrics', () => {
  const mig007 = fs.readFileSync(
    path.resolve(
      __dirname,
      '../migrations/007_strict_outbox_id_and_rate_limit_cleanup.up.sql',
    ),
    'utf8',
  );
  assert.match(mig007, /IF NEW\.id IS NOT NULL THEN\s+RAISE EXCEPTION/);
  assert.match(mig007, /PERFORM pg_advisory_xact_lock\(842026002\)/);
  assert.match(mig007, /NEW\.id := nextval\('outbox_events_id_seq'\)/);

  const authCode = fs.readFileSync(path.resolve(__dirname, '../src/routes/auth.ts'), 'utf8');
  assert.equal(
    authCode.includes('enrollInActiveHackathon'),
    false,
    'Public registration route must not accept enrollInActiveHackathon opt-out',
  );
  assert.match(authCode, /scope:\s*'auth_email'/);
  assert.match(authCode, /sha256Hex\(`login_email:\$\{body\.email\}`\)/);

  const k6Code = fs.readFileSync(path.resolve(__dirname, '../load/board.k6.js'), 'utf8');
  assert.match(k6Code, /data\.metrics\['http_reqs\{scenario:board_load\}'\]/);
  assert.match(k6Code, /data\.metrics\['http_reqs\{scenario:board_warmup\}'\]/);
});
