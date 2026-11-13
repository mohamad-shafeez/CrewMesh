import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadTsModule(tsFilePath, customRequireMap = {}) {
  const require = createRequire('/usr/share/nodejs/index.js');
  const babel = require('@babel/core');
  const rawSource = fs
    .readFileSync(tsFilePath, 'utf8')
    .replaceAll('import.meta.url', JSON.stringify(`file://${tsFilePath}`));
  const transformed = babel.transformSync(rawSource, {
    filename: tsFilePath,
    presets: [[require.resolve('@babel/preset-typescript'), { allExtensions: true }]],
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
    configFile: false,
    babelrc: false,
  });

  const customRequire = (id) => {
    if (Object.prototype.hasOwnProperty.call(customRequireMap, id)) {
      return customRequireMap[id];
    }
    return require(id);
  };

  const mod = { exports: {} };
  const fn = new Function(
    'exports',
    'require',
    'module',
    '__filename',
    '__dirname',
    transformed.code,
  );
  fn(mod.exports, customRequire, mod, tsFilePath, path.dirname(tsFilePath));
  return mod.exports;
}

const csrfMod = loadTsModule(path.resolve(__dirname, '../src/security/csrf.ts'), {
  '../config/env.js': { getEnv: () => ({ APP_ORIGIN: 'https://crewmesh.example.com' }) },
  './crypto.js': { verifyCsrfTokenHash: () => true },
});

test('1. Migration 006 serializes outbox sequence allocation under pg_advisory_xact_lock(842026002) and enforces hackathon_participants foreign keys', () => {
  const upSql = fs.readFileSync(
    path.resolve(
      __dirname,
      '../migrations/006_outbox_commit_order_and_participant_fk.up.sql',
    ),
    'utf8',
  );
  const downSql = fs.readFileSync(
    path.resolve(
      __dirname,
      '../migrations/006_outbox_commit_order_and_participant_fk.down.sql',
    ),
    'utf8',
  );

  assert.match(upSql, /ALTER TABLE outbox_events\s+ALTER COLUMN id DROP DEFAULT/);
  assert.match(upSql, /PERFORM pg_advisory_xact_lock\(842026002\)/);
  assert.match(upSql, /NEW\.id := nextval\('outbox_events_id_seq'\)/);
  assert.match(upSql, /CREATE TRIGGER trg_outbox_events_serialize_id\s+BEFORE INSERT ON outbox_events/);
  assert.match(upSql, /ADD CONSTRAINT team_members_participant_fk/);
  assert.match(upSql, /ADD CONSTRAINT join_requests_participant_fk/);

  assert.match(downSql, /DROP TRIGGER IF EXISTS trg_outbox_events_serialize_id ON outbox_events/);
  assert.match(downSql, /ALTER COLUMN id SET DEFAULT nextval\('outbox_events_id_seq'\)/);
});

test('2. DEFECT-02 regression check: acceptJoinRequestTx does not double-increment invite_codes.use_count already consumed by redeemInviteCodeTx', () => {
  const inviteServiceCode = fs.readFileSync(
    path.resolve(__dirname, '../src/services/invite-service.ts'),
    'utf8',
  );
  const joinRequestServiceCode = fs.readFileSync(
    path.resolve(__dirname, '../src/services/join-request-service.ts'),
    'utf8',
  );

  // redeemInviteCodeTx must increment use_count + 1 and enforce requireActiveHackathonParticipantTx
  assert.match(inviteServiceCode, /await requireActiveHackathonParticipantTx\(client,\s*team\.hackathon_id,\s*params\.actorUserId\)/);
  assert.match(inviteServiceCode, /SET use_count = use_count \+ 1/);

  // acceptJoinRequestTx must NOT increment use_count a second time
  assert.equal(
    joinRequestServiceCode.includes('SET use_count = use_count + 1'),
    false,
    'acceptJoinRequestTx must not double-increment invite_codes.use_count',
  );
});

test('3. DEFECT-03 regression check: requireActiveHackathonParticipantTx locks hackathon_participants FOR KEY SHARE and never auto-inserts unregistered users', () => {
  const teamServiceCode = fs.readFileSync(
    path.resolve(__dirname, '../src/services/team-service.ts'),
    'utf8',
  );

  const fnStart = teamServiceCode.indexOf('export async function requireActiveHackathonParticipantTx');
  assert.ok(fnStart >= 0, 'requireActiveHackathonParticipantTx must be defined');
  const fnSlice = teamServiceCode.slice(fnStart, fnStart + 900);

  assert.match(fnSlice, /FROM hackathon_participants\s+WHERE hackathon_id = \$1 AND user_id = \$2\s+FOR KEY SHARE/);
  assert.equal(
    fnSlice.includes('INSERT INTO hackathon_participants'),
    false,
    'requireActiveHackathonParticipantTx must not auto-enroll unregistered accounts',
  );
  assert.match(fnSlice, /NOT_HACKATHON_PARTICIPANT/);
});

test('4. DEFECT-04 regression check: OutboxSseDispatcher immediately closes removed/departed member streams and re-verifies team access on heartbeats', () => {
  const sseDispatcherCode = fs.readFileSync(
    path.resolve(__dirname, '../src/services/sse-dispatcher.ts'),
    'utf8',
  );

  assert.match(
    sseDispatcherCode,
    /row\.event_type === 'MEMBER_REMOVED' && row\.payload\?\.removedUserId === subscriber\.userId/,
  );
  assert.match(
    sseDispatcherCode,
    /row\.event_type === 'MEMBER_LEFT' && row\.payload\?\.departedUserId === subscriber\.userId/,
  );
  assert.match(
    sseDispatcherCode,
    /const authState = await this\.verifyTeamSubscriberAccess\(sub,\s*'TEAM_UPDATED'\)/,
  );
});

test('5. DEFECT-06 regression check: isAllowedOrigin rejects forged non-loopback Host headers in production', () => {
  const { isAllowedOrigin } = csrfMod;

  const prevEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';

    // Exact configured APP_ORIGIN is permitted
    assert.equal(
      isAllowedOrigin(
        'https://crewmesh.example.com',
        undefined,
        'https://crewmesh.example.com',
        'api.crewmesh.example.com',
      ),
      true,
    );

    // Spoofed Host header matching attacker Origin must be rejected in production
    assert.equal(
      isAllowedOrigin(
        'https://attacker.example.org',
        undefined,
        'https://crewmesh.example.com',
        'attacker.example.org',
      ),
      false,
    );
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});
