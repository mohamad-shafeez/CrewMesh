import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadTsModule } from '../../../scripts/ts-loader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sharedMod = loadTsModule(path.resolve(__dirname, '../../../packages/shared/src/index.ts'));
const errorHandlerMod = loadTsModule(path.resolve(__dirname, '../src/plugins/error-handler.ts'), {
  '@crewmesh/shared': sharedMod,
  zod: { ZodError: class ZodError extends Error {} },
  '../config/env.js': { getEnv: () => ({ NODE_ENV: 'test' }) },
});
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
        DATABASE_URL: 'postgresql://localhost/test',
        DATABASE_SSL: 'disable',
      }),
    },
    '../db/pool.js': {
      getDbPool: () => ({}),
      resolvePgSslOptions: () => undefined,
    },
    '../plugins/error-handler.js': errorHandlerMod,
    './audit-outbox-service.js': auditOutboxMod,
  },
);

const {
  parseLastEventId,
  projectPublicBoardSseEvent,
  projectTeamStreamSseEvent,
  formatSseFrame,
} = sseDispatcherMod;

test('1. parseLastEventId safely parses 64-bit PostgreSQL BIGINT IDs beyond Number.MAX_SAFE_INTEGER', () => {
  assert.equal(parseLastEventId(undefined), null);
  assert.equal(parseLastEventId('   '), null);
  assert.equal(parseLastEventId('42'), 42n);

  // Beyond 2^53 - 1 (9007199254740991)
  const largeBigIntStr = '9007199254740999';
  assert.equal(parseLastEventId(largeBigIntStr), 9007199254740999n);

  assert.throws(() => parseLastEventId('-5'), /non-negative integer/);
  assert.throws(() => parseLastEventId('abc'), /non-negative integer/);
  assert.throws(() => parseLastEventId('99999999999999999999'), /BIGINT bounds/);
});

test('2. projectPublicBoardSseEvent blocks private team events and strips applicant/member PII from board updates', () => {
  const privateJrRow = {
    id: '101',
    hackathon_id: 'h-1',
    team_id: 't-1',
    scope: 'team',
    event_type: 'JOIN_REQUEST_CREATED',
    payload: {
      joinRequestId: 'jr-1',
      applicantUserId: 'u-secret',
    },
    created_at: new Date('2026-11-13T06:00:00.000Z'),
  };
  assert.equal(projectPublicBoardSseEvent(privateJrRow), null);

  const memberJoinedRow = {
    id: '102',
    hackathon_id: 'h-1',
    team_id: 't-1',
    scope: 'both',
    event_type: 'MEMBER_JOINED',
    payload: {
      teamId: 't-1',
      hackathonId: 'h-1',
      userId: 'u-member',
      applicantUserId: 'u-member',
      email: 'should-never-leak@example.com',
      memberCount: 2,
      minTeamSize: 2,
      maxTeamSize: 5,
      status: 'ready',
      isFull: false,
    },
    created_at: new Date('2026-11-13T06:01:00.000Z'),
  };

  const boardEvent = projectPublicBoardSseEvent(memberJoinedRow);
  assert.ok(boardEvent);
  assert.equal(boardEvent.eventId, '102');
  assert.equal(boardEvent.eventType, 'MEMBER_JOINED');
  assert.equal(boardEvent.memberCount, 2);
  assert.equal(boardEvent.status, 'ready');
  assert.equal('userId' in boardEvent, false);
  assert.equal('applicantUserId' in boardEvent, false);
  assert.equal('email' in boardEvent, false);
});

test('3. projectTeamStreamSseEvent enforces leader-only vs regular-member visibility on team streams', () => {
  const jrCreatedRow = {
    id: '201',
    hackathon_id: 'h-1',
    team_id: 't-1',
    scope: 'team',
    event_type: 'JOIN_REQUEST_CREATED',
    payload: {
      joinRequestId: 'jr-99',
      applicantUserId: 'u-applicant',
      status: 'pending',
    },
    created_at: new Date('2026-11-13T06:05:00.000Z'),
  };

  // Regular member must NOT receive JOIN_REQUEST_CREATED
  assert.equal(projectTeamStreamSseEvent(jrCreatedRow, 'member'), null);

  // Leader MUST receive JOIN_REQUEST_CREATED
  const leaderView = projectTeamStreamSseEvent(jrCreatedRow, 'leader');
  assert.ok(leaderView);
  assert.equal(leaderView.eventId, '201');
  assert.equal(leaderView.data.joinRequestId, 'jr-99');

  // Both regular member and leader receive LEADER_SUCCESSION
  const successionRow = {
    id: '202',
    hackathon_id: 'h-1',
    team_id: 't-1',
    scope: 'both',
    event_type: 'LEADER_SUCCESSION',
    payload: {
      newLeaderUserId: 'u-2',
      memberCount: 2,
    },
    created_at: new Date('2026-11-13T06:06:00.000Z'),
  };
  assert.ok(projectTeamStreamSseEvent(successionRow, 'member'));
  assert.ok(projectTeamStreamSseEvent(successionRow, 'leader'));
});

test('4. formatSseFrame formats compliant text/event-stream frames', () => {
  const frame = formatSseFrame({
    id: '9007199254740999',
    event: 'TEAM_CREATED',
    data: { teamId: 't-1', status: 'forming' },
  });
  assert.equal(
    frame,
    'id: 9007199254740999\nevent: TEAM_CREATED\ndata: {"teamId":"t-1","status":"forming"}\n\n',
  );
});

test('5. Migration 003 drops NOT NULL on registration_deadline and adds notify_outbox_event trigger', () => {
  const upPath = path.resolve(
    __dirname,
    '../migrations/003_nullable_deadline_and_outbox_notify.up.sql',
  );
  const downPath = path.resolve(
    __dirname,
    '../migrations/003_nullable_deadline_and_outbox_notify.down.sql',
  );

  const upSql = fs.readFileSync(upPath, 'utf8');
  const downSql = fs.readFileSync(downPath, 'utf8');

  assert.match(upSql, /ALTER TABLE hackathons\s+ALTER COLUMN registration_deadline DROP NOT NULL;/);
  assert.match(upSql, /CREATE OR REPLACE FUNCTION notify_outbox_event\(\)/);
  assert.match(upSql, /PERFORM pg_notify\(\s*'crewmesh_outbox'/);
  assert.match(upSql, /CREATE TRIGGER trg_outbox_events_notify\s+AFTER INSERT ON outbox_events/);

  assert.match(downSql, /DROP TRIGGER IF EXISTS trg_outbox_events_notify ON outbox_events;/);
  assert.match(downSql, /DROP FUNCTION IF EXISTS notify_outbox_event\(\);/);
});

test('6. invite-service.ts redeemInviteCodeTx creates a pending join_request and never directly inserts into team_members', () => {
  const inviteServicePath = path.resolve(__dirname, '../src/services/invite-service.ts');
  const source = fs.readFileSync(inviteServicePath, 'utf8');

  const redeemFnSource = source.slice(source.indexOf('export async function redeemInviteCodeTx'));
  assert.match(redeemFnSource, /INSERT INTO join_requests/);
  assert.match(redeemFnSource, /'invite_code'/);
  assert.match(redeemFnSource, /'pending'/);
  assert.equal(
    redeemFnSource.includes('addMemberToLockedTeamTx'),
    false,
    'redeemInviteCodeTx must not call addMemberToLockedTeamTx directly',
  );
  assert.equal(
    redeemFnSource.includes('INSERT INTO team_members'),
    false,
    'redeemInviteCodeTx must not insert into team_members directly',
  );
});
