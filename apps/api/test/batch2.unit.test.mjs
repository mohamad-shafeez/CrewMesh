import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadTsModule } from '../../../scripts/ts-loader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sharedMod = loadTsModule(path.resolve(__dirname, '../../../packages/shared/src/index.ts'));
const cryptoMod = loadTsModule(path.resolve(__dirname, '../src/security/crypto.ts'), {
  argon2: {
    argon2id: 2,
    hash: async () => '',
    verify: async () => false,
  },
});
const errorHandlerMod = loadTsModule(path.resolve(__dirname, '../src/plugins/error-handler.ts'), {
  '@crewmesh/shared': sharedMod,
  zod: { ZodError: class ZodError extends Error {} },
  '../config/env.js': { getEnv: () => ({ NODE_ENV: 'test' }) },
});
const cursorMod = loadTsModule(path.resolve(__dirname, '../src/services/cursor.ts'), {
  '../plugins/error-handler.js': errorHandlerMod,
});
const auditOutboxMod = loadTsModule(
  path.resolve(__dirname, '../src/services/audit-outbox-service.ts'),
  {
    '@crewmesh/shared': sharedMod,
  },
);

const { canonicalJsonStringify } = sharedMod;
const { sha256Hex } = cryptoMod;
const { encodeKeysetCursor, decodeKeysetCursor } = cursorMod;
const { sanitizeEventMetadata } = auditOutboxMod;

test('1. canonicalJsonStringify produces identical SHA-256 request hashes regardless of object key order', () => {
  const payloadA = {
    body: { name: 'Alpha Team', desiredSkills: ['rust', 'pg'], lookingForMembers: true },
    params: { hackathonId: 'hack4hack-crew-2026' },
  };
  const payloadB = {
    params: { hackathonId: 'hack4hack-crew-2026' },
    body: { lookingForMembers: true, desiredSkills: ['rust', 'pg'], name: 'Alpha Team' },
  };
  const payloadModified = {
    params: { hackathonId: 'hack4hack-crew-2026' },
    body: { lookingForMembers: false, desiredSkills: ['rust', 'pg'], name: 'Alpha Team' },
  };

  const hashA = sha256Hex(canonicalJsonStringify(payloadA));
  const hashB = sha256Hex(canonicalJsonStringify(payloadB));
  const hashMod = sha256Hex(canonicalJsonStringify(payloadModified));

  assert.equal(hashA, hashB);
  assert.notEqual(hashA, hashMod);
});

test('2. Keyset cursor encoder/decoder round-trips valid cursors and rejects tampered strings', () => {
  const sampleId = crypto.randomUUID();
  const sampleDate = '2026-11-13T06:00:00.000Z';
  const encoded = encodeKeysetCursor({ createdAt: sampleDate, id: sampleId });
  const decoded = decodeKeysetCursor(encoded);

  assert.equal(decoded.id, sampleId);
  assert.equal(decoded.createdAt, sampleDate);

  assert.throws(() => decodeKeysetCursor('not-valid-base64-json'), /Invalid|Unexpected/);
  const badUuidCursor = Buffer.from(
    JSON.stringify({ createdAt: sampleDate, id: 'not-a-uuid' }),
    'utf8',
  ).toString('base64url');
  assert.throws(() => decodeKeysetCursor(badUuidCursor), /Invalid pagination cursor/);
});

test('3. sanitizeEventMetadata strips raw invite codes, tokens, and password hashes recursively', () => {
  const dirty = {
    teamId: '11111111-1111-1111-1111-111111111111',
    tokenPrefix: 'AbCdEf12',
    code: 'SECRET_RAW_INVITE_CODE_DO_NOT_LOG',
    password_hash: '$argon2id$secret',
    nested: {
      safeField: 42,
      sessionToken: 'SECRET_SESSION_TOKEN',
      csrfToken: 'SECRET_CSRF_TOKEN',
    },
  };

  const sanitized = sanitizeEventMetadata(dirty);
  assert.equal(sanitized.teamId, '11111111-1111-1111-1111-111111111111');
  assert.equal(sanitized.tokenPrefix, 'AbCdEf12');
  assert.equal('code' in sanitized, false);
  assert.equal('password_hash' in sanitized, false);
  assert.deepEqual(sanitized.nested, { safeField: 42 });
});

test('4. Migration 002 defines deferred constraint triggers enforcing member_count == COUNT(team_members) and single leader', () => {
  const upPath = path.resolve(__dirname, '../migrations/002_team_engine_and_integrity.up.sql');
  const downPath = path.resolve(__dirname, '../migrations/002_team_engine_and_integrity.down.sql');

  const upSql = fs.readFileSync(upPath, 'utf8');
  const downSql = fs.readFileSync(downPath, 'utf8');

  assert.match(upSql, /CREATE OR REPLACE FUNCTION verify_team_membership_integrity\(\)/);
  assert.match(
    upSql,
    /CREATE CONSTRAINT TRIGGER trg_teams_verify_integrity[\s\S]*DEFERRABLE INITIALLY DEFERRED/,
  );
  assert.match(
    upSql,
    /CREATE CONSTRAINT TRIGGER trg_team_members_verify_integrity[\s\S]*DEFERRABLE INITIALLY DEFERRED/,
  );
  assert.match(upSql, /IF v_team\.member_count <> v_actual_count THEN/);
  assert.match(upSql, /IF v_leader_count <> 1 THEN/);
  assert.match(upSql, /IF v_actual_leader_id IS DISTINCT FROM v_team\.leader_user_id THEN/);

  assert.match(
    downSql,
    /DROP TRIGGER IF EXISTS trg_team_members_verify_integrity ON team_members;/,
  );
  assert.match(downSql, /DROP TRIGGER IF EXISTS trg_teams_verify_integrity ON teams;/);
  assert.match(downSql, /DROP FUNCTION IF EXISTS verify_team_membership_integrity\(\);/);
});
